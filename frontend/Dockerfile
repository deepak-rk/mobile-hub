FROM node:20-alpine AS builder
WORKDIR /app
# Empty = same-origin: the bundle calls relative /api and opens ws(s):// on
# the page's own host, which nginx.conf proxies to the backend. Set it only
# for a split-origin deployment (and allow that origin in backend CORS).
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
# Build context is the repo root (see docker-compose.yml) so the npm
# workspaces lockfile at the root is available — `npm ci` needs it and fails
# otherwise. `--workspace` scopes the install to this package's deps.
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
RUN npm ci --workspace=frontend
COPY frontend ./frontend
RUN npm run build --workspace=frontend

FROM nginx:alpine AS runner
COPY --from=builder /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
