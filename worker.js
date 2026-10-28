import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

// ============================================================
// VCALL WORKER
// WhatsApp Web (Chromium) එකක් 24/7 run කරලා, call එකක් ආවම answer කරලා
// .addvcall වලින් දාපු video එක fake camera එක විදිහට පෙන්නනවා.
//
// ⚠️ Bot එකෙන් වෙනම service එකක් විදිහට run කරන්න (RAM 1GB+).
// ⚠️ WhatsApp Web UI selectors මම test කරලා නෑ. /screenshot සහ /debug/buttons වලින් බලලා
//    ඕන නම් VCALL_ACCEPT_REGEX / VCALL_END_REGEX env වලින් හදාගන්න.
//
// Env:
//   VCALL_TOKEN          (අනිවාර්යයි) Bot එකත් එක්ක share කරන secret
//   PORT                 default 3000
//   DATA_DIR             default /data   (Volume එකක් mount කරන්න: profile + video persist වෙන්න)
//   VCALL_ACCEPT_REGEX   default ^(accept|answer)
//   VCALL_END_REGEX      default (end call|leave call|hang up|end$)
//   VCALL_MAX_SECONDS    default 180   (call එකක උපරිම කාලය)
//   VCALL_VIDEO_SECONDS  default 60    (video එක loop වෙන දිග, මීට වැඩි නම් කපනවා)
// ============================================================

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.VCALL_TOKEN || '';
const DATA = process.env.DATA_DIR || '/data';
const ACCEPT_RE = new RegExp(process.env.VCALL_ACCEPT_REGEX || '^(accept|answer)', 'i');
const END_RE = new RegExp(process.env.VCALL_END_REGEX || '(end call|leave call|hang up|end$)', 'i');
const MAX_CALL_SECONDS = Number(process.env.VCALL_MAX_SECONDS) || 180;
const VIDEO_SECONDS = Number(process.env.VCALL_VIDEO_SECONDS) || 60;
const MAX_UPLOAD = 60 * 1024 * 1024;

const PROFILE = path.join(DATA, 'profile');
const VIDEO_FILE = path.join(DATA, 'video.mjpeg');
const AUDIO_FILE = path.join(DATA, 'audio.wav');
const STATE_FILE = path.join(DATA, 'state.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

let state = { enabled: false, hasVideo: false, updatedAt: 0 };
let ctx = null;
let restarting = false;
let inCall = false;
let callStartedAt = 0;
let lastCallAt = 0;
let startedAt = Date.now();

// ───────── helpers ─────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function exists(file) {
    try { await fs.access(file); return true; } catch { return false; }
}

async function saveState() {
    state.updatedAt = Date.now();
    await fs.writeFile(STATE_FILE, JSON.stringify(state)).catch(() => {});
}

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', d => { err = (err + d).slice(-2000); });
        p.on('error', reject);
        p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').pop()}`)));
    });
}

// ───────── video convert (ffmpeg) ─────────
// Chromium fake camera = MJPEG file (y4m වගේ ලොකු නෑ), fake mic = 16-bit PCM wav. දෙකම loop වෙනවා.
async function convertVideo(inputFile) {
    await run('ffmpeg', [
        '-loglevel', 'error', '-y', '-i', inputFile, '-t', String(VIDEO_SECONDS), '-an',
        '-vf', 'fps=24,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2',
        '-c:v', 'mjpeg', '-q:v', '4', '-f', 'mjpeg', VIDEO_FILE
    ]);

    try {
        await run('ffmpeg', [
            '-loglevel', 'error', '-y', '-i', inputFile, '-t', String(VIDEO_SECONDS), '-vn',
            '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', AUDIO_FILE
        ]);
    } catch {
        // video එකේ audio නැත්නම් නිශ්ශබ්ද track එකක්
        await run('ffmpeg', [
            '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
            '-t', String(VIDEO_SECONDS), '-c:a', 'pcm_s16le', AUDIO_FILE
        ]);
    }
}

// ───────── browser ─────────

async function startBrowser() {
    await fs.mkdir(PROFILE, { recursive: true });

    const args = [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream'
    ];

    // Fake camera / mic ටික browser එක launch වෙද්දී විතරයි දෙන්න පුළුවන් (video වෙනස් කළොත් restart වෙනවා)
    if (state.hasVideo && await exists(VIDEO_FILE) && await exists(AUDIO_FILE)) {
        args.push(
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-video-capture=${VIDEO_FILE}`,
            `--use-file-for-fake-audio-capture=${AUDIO_FILE}`
        );
    }

    ctx = await chromium.launchPersistentContext(PROFILE, {
        channel: 'chromium',        // full (new headless) Chromium - WebRTC සඳහා
        headless: true,
        locale: 'en-US',
        userAgent: UA,
        viewport: { width: 1280, height: 800 },
        permissions: ['camera', 'microphone', 'notifications'],
        args
    });

    ctx.on('close', () => { ctx = null; });

    const page = ctx.pages()[0] || await ctx.newPage();
    page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch(err => console.error('WhatsApp Web load failed:', err.message));
}

async function stopBrowser() {
    const c = ctx;
    ctx = null;
    inCall = false;
    if (c) await c.close().catch(() => {});
}

async function restartBrowser() {
    if (restarting) return;
    restarting = true;

    try {
        await stopBrowser();
        await sleep(1000);
        await startBrowser();
    } finally {
        restarting = false;
    }
}

function mainPage() {
    return ctx?.pages()?.[0] || null;
}

// WhatsApp Web එකේ "Calls" tab එක තියෙනවාද (calling feature එක මේ account/browser එකට on වෙලාද කියලා බලන්න)
async function callsTabAvailable() {
    const page = mainPage();
    if (!page) return false;

    try {
        return await page.getByRole('button', { name: /^calls$/i }).first().isVisible({ timeout: 300 });
    } catch {
        return false;
    }
}

// "What's new on WhatsApp Web" වගේ dialogs වලට Continue ඔබනවා (call UI එක block වෙන්න එපා)
async function dismissDialogs() {
    const page = mainPage();
    if (!page || inCall) return;

    const btn = await findVisible(page.getByRole('button', { name: /^(continue|got it|ok)$/i }));
    if (btn) await btn.click().catch(() => {});
}

async function loginState() {
    const page = mainPage();
    if (!page) return 'stopped';

    try {
        if (await page.locator('#pane-side').count()) return 'logged_in';
        if (await page.locator('canvas').count()) return 'qr';
        return 'loading';
    } catch {
        return 'unknown';
    }
}

// ───────── call handling ─────────

async function findVisible(locator) {
    try {
        const first = locator.first();
        return (await first.isVisible({ timeout: 300 })) ? first : null;
    } catch {
        return null;
    }
}

async function tryTurnOnCamera(page) {
    for (let i = 0; i < 6; i++) {
        const cam = await findVisible(page.getByRole('button', { name: /(turn on|start|enable).*(camera|video)|camera off|video off/i }));

        if (cam) {
            await cam.click().catch(() => {});
            return true;
        }
        await sleep(1000);
    }
    return false;
}

async function monitorCall(page) {
    let missed = 0;

    while (ctx && inCall) {
        await sleep(2000);

        const end = await findVisible(page.getByRole('button', { name: END_RE }));

        if (!end) {
            if (++missed >= 3) break;     // call UI නැතිවෙලා = call එක ඉවරයි
            continue;
        }

        missed = 0;

        if ((Date.now() - callStartedAt) / 1000 > MAX_CALL_SECONDS) {
            await end.click().catch(() => {});
            break;
        }
    }

    inCall = false;
    lastCallAt = Date.now();
}

async function checkIncomingCall() {
    if (!ctx || restarting || inCall) return;
    if (!state.enabled || !state.hasVideo) return;

    for (const page of ctx.pages()) {
        const accept = await findVisible(page.getByRole('button', { name: ACCEPT_RE }));
        if (!accept) continue;

        try {
            await accept.click();
            inCall = true;
            callStartedAt = Date.now();
            console.log('📞 Call accepted');

            tryTurnOnCamera(page).catch(() => {});
            monitorCall(page).catch(() => { inCall = false; });
        } catch (err) {
            console.error('Accept click failed:', err.message);
        }

        return;
    }
}

setInterval(() => { dismissDialogs().then(checkIncomingCall).catch(() => {}); }, 1500);

// ───────── HTTP API ─────────

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;

        req.on('data', c => {
            size += c.length;
            if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');

        if (url.pathname === '/health') return json(res, 200, { ok: true });

        const given = req.headers['x-vcall-token'] || url.searchParams.get('token') || '';
        if (!TOKEN || given !== TOKEN) return json(res, 401, { error: 'Unauthorized' });

        if (req.method === 'GET' && url.pathname === '/status') {
            return json(res, 200, {
                ...state,
                login: await loginState(),
                callsTab: await callsTabAvailable(),
                inCall,
                lastCallAt,
                restarting,
                uptimeSec: Math.floor((Date.now() - startedAt) / 1000)
            });
        }

        if (req.method === 'POST' && url.pathname === '/enable') {
            const body = JSON.parse((await readBody(req, 4096)).toString() || '{}');
            state.enabled = body.on === true;
            await saveState();
            return json(res, 200, { ok: true, enabled: state.enabled });
        }

        if (req.method === 'POST' && url.pathname === '/video') {
            const buf = await readBody(req, MAX_UPLOAD);
            if (buf.length < 1000) return json(res, 400, { error: 'empty video' });

            const tmp = path.join(DATA, `upload_${Date.now()}.bin`);
            await fs.mkdir(DATA, { recursive: true });
            await fs.writeFile(tmp, buf);

            try {
                await convertVideo(tmp);
            } finally {
                await fs.unlink(tmp).catch(() => {});
            }

            state.hasVideo = true;
            await saveState();

            // Fake camera එක අලුත් video එකට මාරු වෙන්න browser restart (login එක profile එකේ save)
            restartBrowser().catch(err => console.error('restart failed:', err.message));

            return json(res, 200, { ok: true, hasVideo: true });
        }

        if (req.method === 'DELETE' && url.pathname === '/video') {
            await fs.unlink(VIDEO_FILE).catch(() => {});
            await fs.unlink(AUDIO_FILE).catch(() => {});
            state.hasVideo = false;
            await saveState();

            restartBrowser().catch(err => console.error('restart failed:', err.message));

            return json(res, 200, { ok: true, hasVideo: false });
        }

        // QR scan කරන්න / UI බලන්න
        if (req.method === 'GET' && url.pathname === '/screenshot') {
            const page = mainPage();
            if (!page) return json(res, 503, { error: 'browser not running' });

            const png = await page.screenshot({ type: 'png' });
            res.writeHead(200, { 'Content-Type': 'image/png' });
            return res.end(png);
        }

        // selectors හදාගන්න: දැන් පේන buttons ලැයිස්තුව
        if (req.method === 'GET' && url.pathname === '/debug/buttons') {
            const out = [];

            for (const page of ctx?.pages() || []) {
                const items = await page.evaluate(() =>
                    [...document.querySelectorAll('button, [role="button"]')]
                        .filter(el => el.offsetParent !== null)
                        .map(el => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80))
                        .filter(Boolean)
                ).catch(() => []);

                out.push({ url: page.url(), buttons: items.slice(0, 80) });
            }

            return json(res, 200, { pages: out });
        }

        json(res, 404, { error: 'Not found' });
    } catch (err) {
        console.error('API error:', err.message);
        json(res, err.status || 500, { error: err.message });
    }
});

// ───────── boot ─────────

if (!TOKEN) {
    console.error('❌ VCALL_TOKEN is required.');
    process.exit(1);
}

await fs.mkdir(DATA, { recursive: true });

try {
    state = { ...state, ...JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) };
} catch {}

server.listen(PORT, () => console.log(`📞 VCall worker listening on ${PORT}`));

startBrowser().catch(err => console.error('Browser start failed:', err.message));

process.on('SIGTERM', async () => { await stopBrowser(); process.exit(0); });
process.on('unhandledRejection', (r) => console.error('Unhandled Rejection:', r));
