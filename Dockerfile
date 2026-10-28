FROM mcr.microsoft.com/playwright:v1.56.0-noble

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY worker.js ./

ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "worker.js"]
