FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY backend ./backend
COPY config ./config
COPY dashboard ./dashboard
COPY scripts/seed-demo.js ./scripts/seed-demo.js
USER node
EXPOSE 8080
CMD ["node", "backend/server.js"]
