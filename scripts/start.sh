#!/usr/bin/env bash
# scripts/start.sh — boots the full mobile-hub stack for local/manual testing:
# Mongo (Docker), the Android emulator, backend, frontend, and the host agent.
#
# Run from Git Bash (this repo's whole session history runs through it; see
# docs/LESSONS.md for why paths below are deliberately Windows-native
# (C:/...), not MSYS-style (/c/...) — Node's spawn() on native Windows can't
# resolve the latter, and that exact bug cost real debugging time once
# already).
#
# Usage: scripts/start.sh
# Stop everything this script started with: scripts/stop.sh
#
# Override any of these via env vars before running, e.g.:
#   AVD_NAME=Pixel_6_API_34 scripts/start.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${MOBILEHUB_LOG_DIR:-/tmp/mobile-hub}"
mkdir -p "$LOG_DIR"
PIDFILE="$LOG_DIR/pids"
: > "$PIDFILE"

# Android SDK — derived from the environment, not hardcoded to one machine's
# username. Forced to forward slashes: a value like C:\Users\... straight from
# %LOCALAPPDATA% is fine for Windows generally but not for anything this
# script hands to Node's child_process.spawn() (backend, agent) — see the
# ADB_PATH lesson in docs/LESSONS.md.
_sdk_root_raw="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-${LOCALAPPDATA:-}/Android/Sdk}}"
SDK_ROOT="$(printf '%s' "$_sdk_root_raw" | sed 's#\\#/#g')"

AVD_NAME="${AVD_NAME:-Pixel_3a_API_34_extension_level_7_x86_64}"
ADB_PATH="${ADB_PATH:-$SDK_ROOT/platform-tools/adb.exe}"
EMULATOR_BIN="${EMULATOR_BIN:-$SDK_ROOT/emulator/emulator.exe}"

MONGO_CONTAINER="${MONGO_CONTAINER:-mh-mongo}"
MONGODB_URI="${MONGODB_URI:-mongodb://localhost:27017/mobilehub_dev}"
JWT_SECRET="${JWT_SECRET:-dev_only_not_a_real_secret_32chars_min}"
AGENT_TOKEN="${AGENT_TOKEN:-dev_agent_token_1234567890}"
MACHINE_ID="${MACHINE_ID:-dev-host}"
API_PORT="${API_PORT:-3000}"

log() { printf '[start.sh] %s\n' "$*"; }
die() { printf '[start.sh] ERROR: %s\n' "$*" >&2; exit 1; }

DOCKER_DESKTOP_EXE="${DOCKER_DESKTOP_EXE:-/c/Program Files/Docker/Docker/Docker Desktop.exe}"

command -v docker >/dev/null || die "docker not found on PATH"
[ -x "$ADB_PATH" ] || die "adb not found at $ADB_PATH (set ADB_PATH or ANDROID_HOME)"
[ -x "$EMULATOR_BIN" ] || die "emulator not found at $EMULATOR_BIN (set EMULATOR_BIN or ANDROID_HOME)"

# `docker` on PATH only means the CLI is installed — the daemon (Docker
# Desktop's backend) is a separate thing that isn't always running. Launch it
# and wait rather than failing, since "docker not running" is routine after a
# reboot, not an error state worth stopping the whole stack for.
if ! docker info >/dev/null 2>&1; then
  if [ -x "$DOCKER_DESKTOP_EXE" ]; then
    log "Docker daemon not reachable — launching Docker Desktop..."
    "$DOCKER_DESKTOP_EXE" >/dev/null 2>&1 &
    for _ in $(seq 1 60); do
      docker info >/dev/null 2>&1 && break
      sleep 5
    done
    docker info >/dev/null 2>&1 || die "Docker daemon still not reachable after 5 minutes"
    log "Docker daemon is up."
  else
    die "Docker daemon not reachable and Docker Desktop not found at $DOCKER_DESKTOP_EXE (set DOCKER_DESKTOP_EXE)"
  fi
fi

# Always start from a clean slate: stop whatever this script started last
# time before starting anything new. Cheap when there's nothing recorded
# (stop.sh no-ops), and avoids ever layering a fresh backend/frontend/agent
# on top of stale ones left over from a previous run — see docs/LESSONS.md
# on how quietly that piles up on Windows.
"$ROOT/scripts/stop.sh"

# --- 1. MongoDB ---------------------------------------------------------
if docker ps --format '{{.Names}}' | grep -qx "$MONGO_CONTAINER"; then
  log "Mongo container '$MONGO_CONTAINER' already running."
elif docker ps -a --format '{{.Names}}' | grep -qx "$MONGO_CONTAINER"; then
  log "Starting existing Mongo container '$MONGO_CONTAINER'..."
  docker start "$MONGO_CONTAINER" >/dev/null || die "failed to start Mongo container"
else
  log "Creating Mongo container '$MONGO_CONTAINER'..."
  docker run -d -p 27017:27017 --name "$MONGO_CONTAINER" mongo:7 >/dev/null || die "failed to create Mongo container"
fi

# --- 2. Android emulator -------------------------------------------------
# WARNING: emulator.exe's own Windows crash-reporter (crashpad) writes a full
# dump of the process environment into its startup/crash log as standard
# annotation metadata — not something this script controls or can suppress.
# If any secret is set as an env var on this machine, it can end up in
# LOG_DIR/emulator.log. Treat that file as sensitive: don't cat/tail its raw
# contents into a chat, ticket, or anywhere else without grepping for the
# specific line you need first.
if "$ADB_PATH" devices | grep -q '^emulator-'; then
  log "An emulator is already running — leaving it as-is."
else
  log "Booting AVD '$AVD_NAME' (first boot can take a few minutes)..."
  nohup "$EMULATOR_BIN" -avd "$AVD_NAME" -no-snapshot-save > "$LOG_DIR/emulator.log" 2>&1 &
  echo "emulator:$!" >> "$PIDFILE"

  "$ADB_PATH" wait-for-device
  log "Device attached, waiting for boot to complete..."
  until "$ADB_PATH" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' | grep -q '^1$'; do
    sleep 2
  done
  log "Emulator booted."
fi

# --- 3. Backend -----------------------------------------------------------
if curl -s -m 2 "http://localhost:${API_PORT}/health" >/dev/null 2>&1; then
  log "Backend already responding on :$API_PORT — leaving it as-is."
else
  log "Starting backend..."
  (
    cd "$ROOT/backend"
    ADB_PATH="$ADB_PATH" MONGODB_URI="$MONGODB_URI" JWT_SECRET="$JWT_SECRET" \
      AGENT_TOKEN="$AGENT_TOKEN" API_PORT="$API_PORT" NODE_ENV=development \
      npm run dev > "$LOG_DIR/backend.log" 2>&1 &
    echo "backend:$!" >> "$PIDFILE"
  )
  log "Waiting for backend health check..."
  for _ in $(seq 1 30); do
    curl -s -m 1 "http://localhost:${API_PORT}/health" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -s -m 2 "http://localhost:${API_PORT}/health" >/dev/null 2>&1 \
    || log "WARNING: backend didn't respond after 30s — check $LOG_DIR/backend.log"
fi

# --- 4. Frontend ------------------------------------------------------------
if curl -s -m 2 -o /dev/null "http://localhost:5173" 2>&1; then
  log "Frontend already responding on :5173 — leaving it as-is."
else
  log "Starting frontend..."
  (
    cd "$ROOT/frontend"
    npm run dev > "$LOG_DIR/frontend.log" 2>&1 &
    echo "frontend:$!" >> "$PIDFILE"
  )
fi

# --- 5. Host agent ----------------------------------------------------------
log "Starting host agent (machineId=$MACHINE_ID)..."
(
  cd "$ROOT/backend"
  ADB_PATH="$ADB_PATH" HUB_URL="http://localhost:${API_PORT}" MACHINE_ID="$MACHINE_ID" \
    AGENT_TOKEN="$AGENT_TOKEN" npm run agent > "$LOG_DIR/agent.log" 2>&1 &
  echo "agent:$!" >> "$PIDFILE"
)

log ""
log "Stack starting. Logs under $LOG_DIR/, PIDs recorded in $PIDFILE."
log "  Backend:  http://localhost:${API_PORT}  ($LOG_DIR/backend.log)"
log "  Frontend: http://localhost:5173          ($LOG_DIR/frontend.log)"
log "  Agent:    $LOG_DIR/agent.log"
log "  Emulator: $LOG_DIR/emulator.log"
log ""
log "Stop everything with: scripts/stop.sh"
