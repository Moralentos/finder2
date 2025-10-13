FROM node:20-slim

# Установка OpenSSL для Prisma
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# Устанавливаем зависимости, включая devDependencies для сборки
RUN npm ci && npm cache clean --force

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
COPY tsconfig.json ./
RUN npm run build && rm -rf src tsconfig.json

# Удаляем devDependencies после сборки
RUN npm prune --production

CMD ["node", "dist/index.js"]