FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
COPY tsconfig.json ./
RUN npm run build && rm -rf src tsconfig.json

RUN npm prune --production

CMD ["node", "dist/index.js"]