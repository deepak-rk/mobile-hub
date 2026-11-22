FROM node:20-alpine AS builder
WORKDIR /app
# Build context is the repo root (see docker-compose.yml) so the npm
# workspaces lockfile at the root is available — `npm ci` needs it and fails
# otherwise. `--workspace` scopes the install/build to this package.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
RUN npm ci --workspace=backend
COPY backend/tsconfig.json ./backend/
COPY backend/src ./backend/src
RUN npm run build --workspace=backend

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S mobilehub && adduser -S mobilehub -G mobilehub -h /home/mobilehub
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
RUN npm ci --workspace=backend --omit=dev
COPY --from=builder /app/backend/dist ./backend/dist
RUN mkdir -p /home/mobilehub/mobile-hub-executions /home/mobilehub/mobile-hub-builds \
    && chown -R mobilehub:mobilehub /home/mobilehub
USER mobilehub
EXPOSE 3000
# "Running" is not "serving": the process exists from the first instant,
# but answers HTTP only once it has booted, and stops answering if wedged.
# Node's own fetch, so no curl/wget is needed; the port follows API_PORT
# like the server does.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "backend/dist/server.js"]
