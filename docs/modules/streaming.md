# Module: Live Device Streaming

**Status:** planned — no code written.
**Blueprint ref:** [architecture-blueprint.md §4 (StreamSession), §12a](../architecture-blueprint.md)
**Competitive context:** [competitive-analysis.md §4a, §4d](../competitive-analysis.md)

---

## Purpose

Provide real-time visual access to any registered device from any browser, with a single capture process per device regardless of how many viewers are watching. This is the primary UX surface of Mobile Hub — the thing contributors and testers open first.

---

## The core problem this module solves

Every open-source device lab tool (OpenSTF, DeviceFarmer, appium-device-farm) assumes a 1:1 relationship between a viewer and a device capture process. With three viewers watching the same device, three separate `adb screenrecord` processes run simultaneously — burning CPU, bandwidth, and I/O on the host machine. Prior proprietary implementations made the same mistake for H264 (while correctly sharing MJPEG).

Mobile Hub's `StreamSession` model enforces one capture process per `(machineId, deviceUdid, protocol)` regardless of viewer count. Viewers subscribe to the existing session over WebSocket — they never trigger a new capture.

---

## Data model

### StreamSession
```ts
{
  _id,
  machineId: string,           // ref MachineHost — required, indexed
  deviceUdid: string,
  protocol: 'mjpeg' | 'h264',
  captureStatus: 'starting' | 'active' | 'stopped',
  capturePid: number,          // OS PID of the adb/xcrun process
  retryKey: string,            // UUID, rotated on each capture restart; used by clients to detect reconnects
  viewerIds: string[],         // userIds currently subscribed
  viewerCount: number,         // denormalized for cheap queries
  startedAt: Date,
  lastViewerJoinedAt: Date,    // used for idle teardown
}
// Unique compound index: { machineId: 1, deviceUdid: 1, protocol: 1 }
```

### Device status extension
The `Device.status` enum includes `'smoke'` — device recently smoke-tested and confirmed responsive, distinct from `'idle'` (available but not recently verified):

```ts
status: 'idle' | 'smoke' | 'in-use' | 'offline' | 'unreachable'
```

---

## Streaming protocols

### MJPEG
| Property | Detail |
|---|---|
| **Capture command** | `adb exec-out screencap -p` — repeated in a loop at ~10 fps |
| **Transport** | HTTP `multipart/x-mixed-replace; boundary=frame` response |
| **Browser rendering** | Standard `<img src="http://...">` — no JS required for basic display |
| **Use case** | Default streaming mode; widest browser compatibility, lowest client CPU |
| **Fan-out** | HTTP response is broadcast from the single capture loop to all viewers via SSE/chunked transfer |

### H264
| Property | Detail |
|---|---|
| **Capture command** | `adb screenrecord --output-format=h264 -` (stdout pipe) |
| **Transport** | WebSocket binary frames (streaming WS port) |
| **Browser rendering** | Browser MediaSource API (MSE) — `video` element fed by `SourceBuffer.appendBuffer()` |
| **Use case** | Smooth video at lower bandwidth once a viewer has MSE support |
| **Fan-out** | Single `adb screenrecord` process; `StreamingService` fans H264 chunks to all subscribed WS connections |

---

## Port architecture — why streaming needs its own port

HTTP/1.1 browsers allow **6 concurrent connections per origin** (scheme + host + port). If streaming WebSockets share a port with the REST API, a grid view with 3 devices consumes 3 of those 6 slots — leaving 3 for all other API calls. At 6 devices the browser stops opening new connections.

**Decision:** The streaming WebSocket server binds on a separate port.

```
API_PORT        (default 3000)  — REST + execution WS + SSE log streaming
STREAM_WS_PORT  (default 3001)  — device stream WebSockets only
```

Both ports are configurable via environment variable. The frontend reads `VITE_STREAM_WS_PORT` (or equivalent) at build time. Docker Compose exposes both ports.

---

## retryKey — stream reconnection correlation

When a device stream drops (host machine sleeps, adb restarts, network hiccup), the browser client reconnects. The `retryKey` field on `StreamSession` is an opaque UUID rotated every time the capture process restarts. The client receives `retryKey` on join; when it reconnects and gets a different `retryKey`, it knows the stream was interrupted rather than just paused — this lets the UI distinguish "brief reconnect" from "stream was restarted; resync needed."

**Backend:** rotate `retryKey` in `StreamingService.restartCapture()`.
**Frontend:** compare incoming `retryKey` with the stored value on reconnect; if different, flush MSE buffer and show a "stream restarted" indicator.

---

## Device discovery loop (DeviceAgentService)

| Platform | Command | Poll interval |
|---|---|---|
| Android | `adb devices -l` | 10 seconds |
| iOS simulators | `xcrun simctl list --json` | 10 seconds |
| iOS physical (V3) | WebDriverAgent-based | event-driven, not polling |

On each poll, the agent compares discovered UDIDs against the current `Device` collection for this `machineId` and:
- Inserts new devices with `status: 'idle'`
- Marks previously-seen devices that are no longer in the output as `status: 'offline'`
- Updates `lastSeenAt` on active devices

---

## iOS simulator streaming limit

`xcrun simctl io <udid> recordVideo` silently drops frames when more than **8 concurrent simulator recordings** run on a single Mac host. Mobile Hub enforces a hard cap:

`StreamingService` rejects a new `StreamSession` start for an iOS simulator device if the host machine already has 8 active iOS simulator `StreamSession` records.

This cap applies only to simulators. Physical iOS devices and all Android devices are not subject to this limit.

---

## Idle timeout & session teardown

A `StreamSession` with `viewerIds.length === 0` after a viewer disconnects is not immediately torn down — another viewer may join within seconds. A background job in `StreamingService` checks for sessions where:

```
captureStatus === 'active'
AND viewerCount === 0
AND lastViewerJoinedAt < (now - 10 minutes)
```

Any matching session triggers `StreamingService.stopCapture(session._id)` — the capture process is killed, `captureStatus` is set to `'stopped'`, and the session record is cleaned up.

---

## API surface

### REST
```
GET  /api/devices/:udid/stream/status    — returns active StreamSession for the device (or null)
POST /api/devices/:udid/stream/start     — operator: ensure a StreamSession is active (idempotent)
POST /api/devices/:udid/stream/stop      — operator: force-stop the capture process
```

### WebSocket (STREAM_WS_PORT)
```
WS /ws/stream/:deviceUdid?protocol=mjpeg|h264&token=<jwt>
```

**On connect:** server finds or starts the `StreamSession`, adds `userId` to `viewerIds`, sends a join acknowledgment:
```json
{ "type": "joined", "sessionId": "...", "retryKey": "...", "protocol": "h264" }
```

**While active:** server pushes binary frames (H264) or sends no WS messages (MJPEG — delivered separately over HTTP).

**On disconnect:** server removes `userId` from `viewerIds`, starts idle-timeout countdown.

---

## StreamingService responsibilities

| Responsibility | Notes |
|---|---|
| Find-or-create `StreamSession` | Atomic `findOneAndUpdate` with upsert — never creates two sessions for the same `(machineId, deviceUdid, protocol)` |
| Spawn capture process | Delegates to host agent via REST call to the agent; agent owns the `adb`/`xcrun` subprocess |
| Fan-out frames | Maintains a per-session subscriber list of WebSocket connections; pushes each incoming frame chunk to all subscribers |
| Viewer subscribe/unsubscribe | Updates `viewerIds` and `viewerCount`; rotates `retryKey` on capture restart |
| Idle teardown | Background interval, checks every 60 seconds, kills processes idle for 10+ minutes |
| iOS simulator cap enforcement | Counts active iOS simulator sessions per `machineId` before allowing a new start |

---

## Frontend component isolation

Live-streaming components must be isolated from the general CRUD UI. A dropped WebSocket must not break the device list, execution panel, or analytics tab. Structure:

```
src/features/devices/
  components/
    DeviceGrid.tsx          — grid of DeviceCard tiles
    DeviceCard.tsx          — thumbnail + status badge; owns the MJPEG <img> tag
    DeviceViewer.tsx        — full-screen viewer; owns the H264 MSE video element
    StreamStatusBanner.tsx  — connection-state indicator (connecting / live / reconnecting / dropped)
  hooks/
    useDeviceStream.ts      — manages WS lifecycle, retryKey comparison, reconnect backoff
```

`StreamStatusBanner` is non-negotiable — silent reconnect loops without a visible indicator are a documented failure mode. The banner shows the current WS state; if `retryKey` changed on reconnect, it shows "stream restarted."

---

## Known issues from reference — and Mobile Hub fixes

| Reference issue | Root cause | Mobile Hub fix |
|---|---|---|
| H264 stream: 1 process per viewer | No shared-capture model for H264 | `StreamSession` unique compound index enforces 1 process always |
| Stream processes accumulated after idle | No idle timeout | 10-minute zero-viewer teardown via background job |
| Grid views broke at 3+ devices | All streams on same HTTP port, H/1.1 connection limit | Dedicated `STREAM_WS_PORT` separate from API |
| iOS simulator OOM on busy hosts | No cap on concurrent simulator recordings | Hard cap of 8 per Mac host enforced in `StreamingService` |
| No reconnect correlation | No `retryKey` concept | `retryKey` rotated on restart; frontend uses it to detect genuine interruptions |
