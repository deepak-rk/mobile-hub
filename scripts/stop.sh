#!/usr/bin/env bash
# scripts/stop.sh — stops everything scripts/start.sh started.
#
# node processes (backend/frontend/agent) are stopped via
# `taskkill //PID <pid> //T //F` (tree-kill) using the pidfile — on Windows,
# killing just the wrapper PID of an `npm run dev` / `tsx watch` process
# leaves its actual worker child running. A whole session's worth of restarts
# done the naive way once left 66 orphaned node processes behind — see
# docs/LESSONS.md.
#
# The emulator is NOT stopped via its pidfile PID — confirmed the hard way
# that Git Bash's `$!` for a spawned native Windows GUI binary (emulator.exe)
# does not reliably match the real PID `taskkill` needs, which let a stuck
# emulator survive multiple "restarts" undetected while every later launch
# collided with it over the AVD's disk image. Instead: `adb emu kill` for a
# clean shutdown when one is attached, then unconditionally kill by process
# name (emulator.exe / qemu-system-x86_64.exe) as a real backstop — this
# assumes this machine isn't running some *other*, unrelated AVD at the same
# time; fine for a single-project dev box, not safe to assume in general.
#
# Mongo is left running — stop it yourself with `docker stop mh-mongo` if
# you're done with it entirely.
set -uo pipefail

LOG_DIR="${MOBILEHUB_LOG_DIR:-/tmp/mobile-hub}"
PIDFILE="$LOG_DIR/pids"

log() { printf '[stop.sh] %s\n' "$*"; }

_sdk_root_raw="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-${LOCALAPPDATA:-}/Android/Sdk}}"
SDK_ROOT="$(printf '%s' "$_sdk_root_raw" | sed 's#\\#/#g')"
ADB_PATH="${ADB_PATH:-$SDK_ROOT/platform-tools/adb.exe}"

if [ -f "$PIDFILE" ]; then
  while IFS=: read -r name pid; do
    [ -z "${pid:-}" ] && continue
    [ "$name" = "emulator" ] && continue  # handled unconditionally below, not via this PID
    log "Stopping $name (pid $pid, tree-kill)..."
    taskkill //PID "$pid" //T //F >/dev/null 2>&1 \
      || log "  $name (pid $pid) already gone or couldn't be killed"
  done < "$PIDFILE"
  : > "$PIDFILE"
else
  log "No pidfile at $PIDFILE — nothing recorded to stop for backend/frontend/agent."
fi

log "Stopping emulator..."
"$ADB_PATH" emu kill >/dev/null 2>&1
for name in emulator.exe qemu-system-x86_64.exe; do
  pids=$(wmic process where "name='$name'" get ProcessId 2>/dev/null | tr -d '\r' | grep -E '^[0-9]+$')
  for p in $pids; do
    log "  killing $name (pid $p)"
    taskkill //PID "$p" //T //F >/dev/null 2>&1
  done
done

log "Done. Mongo container left running — 'docker stop mh-mongo' to stop it too."
