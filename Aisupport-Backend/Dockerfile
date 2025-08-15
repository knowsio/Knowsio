# Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev  && mkdir -p test/data  && : > test/data/05-versions-space.pdf
COPY . .
EXPOSE 8080
CMD ["node", "index.js"]
