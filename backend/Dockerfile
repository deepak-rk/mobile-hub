FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S mobilehub && adduser -S mobilehub -G mobilehub
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
RUN mkdir -p /home/node/mobile-hub-executions && chown mobilehub:mobilehub /home/node/mobile-hub-executions
USER mobilehub
EXPOSE 3000 3001
CMD ["node", "dist/server.js"]
