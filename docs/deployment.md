# Deployment Guide

**Status:** planned — no docker-compose.yml written yet. This document records the deployment design decisions so they are locked before scaffolding starts.

---

## Design constraint

> A contributor must go from zero to a running Mobile Hub lab in **under 30 minutes** using a single command.

This is a hard product constraint, not a nice-to-have. Every open-source device lab that failed community adoption did so because of operational complexity — OpenSTF's 12-container deployment (RethinkDB + nginx + 10+ STF processes) is the textbook example. Mobile Hub's deployment model is designed around the opposite: one command, one file.

```bash
docker compose up
```

This must be validated as a first-class quality gate before V1 ships. If a contributor cannot get a lab running in under 30 minutes on a clean machine, the deployment is broken — regardless of whether the code works.

---

## Services

| Service | Image | Notes |
|---|---|---|
| `backend` | custom (Node.js + Fastify) | REST API + WebSocket + SSE |
| `frontend` | custom (Nginx serving Vite build) | Static bundle served by Nginx |
| `mongodb` | `mongo:7` | Data store |
| ~~agent~~ | (part of backend in V1) | Runs in-process with the backend on the same host; splits into its own container only when multi-host is needed |

Total: **3 containers in V1**. Not 12.

---

## Port layout

| Port | Service | Notes |
|---|---|---|
| `3000` | Backend REST + WS (execution, log SSE) | Configurable via `API_PORT` |
| `3001` | Backend stream WebSocket | Configurable via `STREAM_WS_PORT`; separate port to bypass HTTP/1.1 6-connection-per-origin limit |
| `5173` | Frontend (dev) | Vite dev server; production uses Nginx on `80` |
| `27017` | MongoDB | Internal only; not exposed on host in production |

---

## docker-compose.yml (target shape)

```yaml
# Target — not final, no code written yet

services:
  mongodb:
    image: mongo:7
    restart: unless-stopped
    volumes:
      - mongo_data:/data/db
    # Not exposed to host — only reachable by backend

  backend:
    build: ./backend
    restart: unless-stopped
    ports:
      - "${API_PORT:-3000}:3000"
      - "${STREAM_WS_PORT:-3001}:3001"
    environment:
      MONGODB_URI: mongodb://mongodb:27017/mobilehub
      JWT_SECRET: ${JWT_SECRET}
      API_PORT: "3000"
      STREAM_WS_PORT: "3001"
      MACHINE_ID: ${MACHINE_ID:-}          # stable host identifier; auto-generated on first boot if not set
      EXECUTIONS_DIR: /home/node/mobile-hub-executions
    volumes:
      - executions:/home/node/mobile-hub-executions
      - /var/run/docker.sock:/var/run/docker.sock:ro   # for adb/agent if needed
    depends_on:
      - mongodb

  frontend:
    build:
      context: ./frontend
      args:
        VITE_API_URL: ${VITE_API_URL:-}   # empty = same-origin (see below)
    restart: unless-stopped
    ports:
      - "80:80"
    depends_on:
      - backend

volumes:
  mongo_data:
  executions:
```

---

## Environment variables

All configuration is via environment variables. For local development, copy `.env.example` to `.env`:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MONGODB_URI` | Yes | — | Full MongoDB connection string |
| `JWT_SECRET` | Yes | — | ≥ 32 random bytes; generate with `openssl rand -hex 32` |
| `API_PORT` | No | `3000` | Backend REST + WS port |
| `STREAM_WS_PORT` | No | `3001` | Stream-only WebSocket port |
| `MACHINE_ID` | No | auto-generated | Stable identifier for this host; persisted to a local file on first boot |
| `EXECUTIONS_DIR` | No | `~/mobile-hub-executions` | Root dir for workspace and cache |
| `VITE_API_URL` | No | empty (same-origin) | Frontend → backend origin, build-time. Leave empty for the bundled nginx deploy — see "Same-origin vs split-origin" below |

---

## MACHINE_ID persistence

The `MACHINE_ID` is a stable, unique identifier for each host running a Mobile Hub agent. It is used as the first-class field (`machineId`) on every host-local MongoDB collection.

Generation logic (runs at backend startup if `MACHINE_ID` env var is not set):

1. Check if `{EXECUTIONS_DIR}/.machine-id` exists and read it.
2. If not, generate a UUID v4, write it to `{EXECUTIONS_DIR}/.machine-id`, use it.
3. Always log the active `MACHINE_ID` at startup (INFO level).

This means `MACHINE_ID` survives container restarts as long as the `executions` volume is mounted. If the volume is deleted, a new ID is generated — devices registered under the old ID will appear as offline until they are re-registered.

---

## Development setup (without Docker)

For contributors who want to run services directly:

**Prerequisites:** Node.js LTS, MongoDB 7 (local or Atlas free tier), ADB installed (for Android device discovery).

```bash
# Clone
git clone https://github.com/deepak-rk/mobile-hub.git
cd mobile-hub

# Install all dependencies (root, backend, frontend)
npm install
cd backend && npm install
cd ../frontend && npm install

# Copy env files
cp backend/.env.example backend/.env      # fill in MONGODB_URI and JWT_SECRET
cp frontend/.env.example frontend/.env.local

# Start backend (port 3000 + 3001)
cd backend && npm run dev

# Start frontend (port 5173)
cd frontend && npm run dev
```

Both services are independently runnable. The backend starts without the frontend. The frontend can point to any backend URL via `VITE_API_URL`.

### Same-origin vs split-origin

By default the frontend is built with an empty `VITE_API_URL`: the browser calls relative `/api/...` and opens WebSockets (device streams, execution and install logs) as `ws(s)://<page host>/api/...`. The frontend container's nginx proxies `/api/` — WebSocket upgrades included — to the backend, so a remote browser never has to reach the backend port and no CORS is involved.

Set `VITE_API_URL` (e.g. `https://api.example.org`, without a trailing `/api`) only when the UI and API are served from different origins. It is baked into the bundle at build time, so rebuild the frontend image after changing it. The backend enables CORS only when `NODE_ENV=development`, so a split-origin production deploy also needs a CORS change in `backend/src/app.ts`, or a reverse proxy that puts both behind one origin.

---

## Multi-host setup (V1+)

In V1, the backend and host agent run in the same process on the same machine. To add a second machine:

1. Clone the repo on the second machine.
2. Set `MACHINE_ID` to a unique value (or let it auto-generate — it will be different from machine 1's ID).
3. Set `MONGODB_URI` to the same central MongoDB instance (Atlas free tier recommended for cross-host connectivity; or use a VPN with a self-hosted MongoDB).
4. Run `docker compose up` (or the dev setup) on the second machine.

The second host's agent will register itself in `MachineHost` collection and begin discovering devices. The central backend serves all hosts' devices from the same frontend.

---

## Production considerations

These are not blocking V1 but should be addressed before a community instance is public-facing:

| Concern | Recommendation |
|---|---|
| HTTPS / TLS | Put Nginx (or Caddy) in front as a reverse proxy; Let's Encrypt for certs |
| MongoDB access | Never expose MongoDB port to the internet; use Atlas or a private network |
| JWT_SECRET rotation | Document the rotation procedure; a compromised secret requires all sessions to be invalidated |
| Rate limiting | `@fastify/rate-limit` is already in the plan (backend CLAUDE.md); ensure it's configured before going public |
| Backup | `mongodump` to a separate volume or S3 on a cron schedule |
| Log retention | Pino logs to stdout; use Docker log driver (e.g. `json-file` with `max-size`) or ship to a log aggregator |

---

## Deployment quality gate

Before V1 ships, this test must pass on a clean machine with no prior Mobile Hub knowledge:

1. `git clone https://github.com/deepak-rk/mobile-hub.git`
2. Copy `.env.example` → `.env`, fill in two values (`MONGODB_URI`, `JWT_SECRET`)
3. `docker compose up`
4. Open `http://localhost` in a browser
5. See a working Mobile Hub UI with device inventory (even if no devices are connected yet)

If this takes more than 30 minutes end-to-end, the deployment is not ready.
