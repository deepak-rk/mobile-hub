# UI Wireframes — Screen Inventory

ASCII wireframes for every major screen. These establish layout intent, information hierarchy, and component groupings before any code is written. Exact styling, color, and spacing are decided during implementation.

Legend:
```
[ Button ]        clickable button
[ v ]             dropdown / select
[ ... ]           text input
━━━━              section separator
░░░░░░            live video / image area
▓▓▓▓▓▓            loading skeleton
```

---

## App shell — shared layout

```
┌────────────────────────────────────────────────────────────────────────┐
│  ⬡ Mobile Hub          Devices  Builds  Execution  Analytics     👤 ▾  │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  [ page content ]                                                        │
│                                                                          │
└────────────────────────────────────────────────────────────────────────┘
```

- Top nav: logo, 4 primary sections, user avatar + role badge + logout dropdown
- No sidebar — nav fits in the top bar for all primary sections
- Role badge shows `viewer` / `operator` / `admin`
- Toast notification area: bottom-right, auto-dismiss, grouped by type (not 1:1 per event)

---

## Screen 1 — Device Grid (main landing)

```
┌────────────────────────────────────────────────────────────────────────┐
│  Devices                                                                 │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  [ All platforms v ]  [ All statuses v ]  [ All hosts v ]  [Search... ] │
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ ● ONLINE     │  │ ● ONLINE     │  │ ○ OFFLINE    │  │ ● IN USE    │ │
│  │              │  │              │  │              │  │             │ │
│  │  ░░░░░░░░░░  │  │  ░░░░░░░░░░  │  │  ░░░░░░░░░░  │  │ ░░░░░░░░░░ │ │
│  │  ░ thumb  ░  │  │  ░ thumb  ░  │  │  ░ thumb  ░  │  │ ░ thumb  ░ │ │
│  │  ░░░░░░░░░░  │  │  ░░░░░░░░░░  │  │  ░░░░░░░░░░  │  │ ░░░░░░░░░░ │ │
│  │              │  │              │  │              │  │             │ │
│  │  Pixel 8     │  │  iPhone 15   │  │  Galaxy S23  │  │  Pixel 7   │ │
│  │  Android 14  │  │  iOS 17.4    │  │  Android 13  │  │ Android 13 │ │
│  │  host-01     │  │  mac-mini-01 │  │  host-01     │  │ host-02    │ │
│  │              │  │              │  │              │  │ 🔒 deepak  │ │
│  │  [ View ]    │  │  [ View ]    │  │  [ View ]    │  │ [ View ]   │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘ │
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  + more cards...                    │
│  │ ...          │  │ ...          │                                      │
│  └──────────────┘  └──────────────┘                                      │
│                                                                          │
│  12 devices  ·  8 online  ·  2 in use  ·  2 offline          [+ Add]   │
└────────────────────────────────────────────────────────────────────────┘
```

- Status dot: green=online/idle, yellow=smoke, orange=in-use, grey=offline/unreachable
- Lock badge shows username of whoever holds the lock
- Thumbnail is an MJPEG snapshot (low-rate, not a full stream) — refreshes every 30s
- `[+ Add]` — admin only; opens host registration flow
- Filters are URL-synced (shareable link)

---

## Screen 2 — Device Viewer (live stream)

```
┌────────────────────────────────────────────────────────────────────────┐
│  ← Devices   Pixel 8 Pro  ·  Android 14  ·  host-01          ● LIVE   │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  ┌────────────────────────────┐  ┌──────────────────────────────────┐  │
│  │                            │  │  Device info                     │  │
│  │                            │  │  ─────────────────────────────   │  │
│  │                            │  │  UDID      abc123def456          │  │
│  │    ░░░░░░░░░░░░░░░░░░░░    │  │  Model     Pixel 8 Pro           │  │
│  │    ░░░░░░░░░░░░░░░░░░░░    │  │  OS        Android 14.0          │  │
│  │    ░░  LIVE STREAM   ░░    │  │  Host      host-01 (Linux)       │  │
│  │    ░░░░░░░░░░░░░░░░░░░░    │  │  Connect   USB                   │  │
│  │    ░░░░░░░░░░░░░░░░░░░░    │  │                                  │  │
│  │    ░░░░░░░░░░░░░░░░░░░░    │  │  Lock                            │  │
│  │                            │  │  ─────────────────────────────   │  │
│  │                            │  │  Status    🔓 Available          │  │
│  │  ─────────────────────── ──│  │  [ Lock device ]                 │  │
│  │  ● Reconnecting...         │  │                                  │  │
│  │  MJPEG  [ Switch to H264 ] │  │  Stream viewers                  │  │
│  │                            │  │  ─────────────────────────────   │  │
│  └────────────────────────────┘  │  2 viewers watching              │  │
│                                  │                                  │  │
│                                  │  Active run                      │  │
│                                  │  ─────────────────────────────   │  │
│                                  │  No active run on this device    │  │
│                                  │  [ Trigger run ]                 │  │
│                                  └──────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

- Stream area: H264 `<video>` or MJPEG `<img>` — swappable without page reload
- `● LIVE` indicator in header; changes to `○ Reconnecting...` on drop, `○ Disconnected` on failure
- StreamStatusBanner overlays the video when not connected — never silently hides the state
- Lock section: `[ Lock device ]` for operator+; shows lock holder and `[ Unlock ]` if locked
- "2 viewers watching" is the `StreamSession.viewerCount` — shows others watching same stream
- "Trigger run" deep-links to the execution trigger form with this device pre-selected
- If a run is active on this device, "Active run" shows the stage pipeline (collapsed, link to full run)

---

## Screen 3 — Builds Library

```
┌────────────────────────────────────────────────────────────────────────┐
│  Builds                                      [ + Fetch build ]         │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  [ All platforms v ]  [ All projects v ]  [ All statuses v ]            │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Version         Platform  Project    Status       Size    Date  │   │
│  │  ─────────────────────────────────────────────────────────────   │   │
│  │  v2.4.1          Android   MyApp      ✅ Ready    48 MB   Aug 21 │   │
│  │  v2.4.1          iOS       MyApp      ✅ Ready    62 MB   Aug 21 │   │
│  │  v2.4.0          Android   MyApp      ✅ Ready    47 MB   Aug 20 │   │
│  │  v2.4.0-rc.1     Android   MyApp      ⚠ Corrupt   —      Aug 19 │   │
│  │  v2.3.9          Android   OtherApp   ▓▓▓▓▓ 67%  —       Aug 21 │   │  ← downloading
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ── Fetch build (slide-in panel) ────────────────────────────────────── │
│                                                                          │
│  Project   [ MyApp v ]         Platform  [ Android v ]                  │
│  Version   [ 2.4.2 ... ]       Source    auto (from org config)         │
│                                                                          │
│  [ Cancel ]                              [ Fetch ]                      │
└────────────────────────────────────────────────────────────────────────┘
```

- Status icons: ✅ Ready, ⏳ Downloading (progress bar inline), 🔍 Validating, ⚠ Corrupt, — (N/A)
- Progress bar for in-flight downloads (`InstallJob.progress`)
- Row click → build detail panel (checksum, artifact URL, full InstallJob history)
- Corrupt builds show an error message and a `[ Retry ]` button
- `[ Fetch build ]` opens a slide-in panel (not a separate page)

---

## Screen 4 — Trigger Execution Run

```
┌────────────────────────────────────────────────────────────────────────┐
│  New Run                                                                 │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  Device                                                                  │
│  [ Select device v ]    ← shows idle devices only, with platform icon   │
│                                                                          │
│  Build                                                                   │
│  [ Select build v ]     ← shows Ready builds matching device platform   │
│                                                                          │
│  Automation repo                                                         │
│  Branch  [ main v ]     ← branches from the configured automation repo  │
│  Suite   [ regression v ] ← suites discovered from the repo config      │
│                                                                          │
│  Advanced  ▾                                                             │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Env overrides (key=value, one per line)                         │   │
│  │  [ APP_ENV=staging                                             ] │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  [ Cancel ]                                        [ Trigger run →  ]   │
│                                                                          │
└────────────────────────────────────────────────────────────────────────┘
```

- Device dropdown: grouped by host, shows platform icon (Android/iOS), status badge, locks out in-use/offline
- Build dropdown: filtered to platform matching selected device; shows version + date
- Suite dropdown: populated from the automation repo's config (polled or manually refreshed)
- Env overrides: project config values are pre-filled; user can add/override per-run values
- `[ Trigger run → ]` navigates directly to the run detail page after successful submission

---

## Screen 5 — Execution Run Detail

```
┌────────────────────────────────────────────────────────────────────────┐
│  ← Execution   Run #a1b2c3  ·  regression  ·  Pixel 8  ·  Aug 21 10:04 │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  ┌──────────────────────────────┐  ┌───────────────────────────────┐   │
│  │  Pipeline                    │  │  Live log                     │   │
│  │                              │  │  ─────────────────────────    │   │
│  │  ✅ pulling          0:04    │  │  INFO  Cloning repo...        │   │
│  │  ✅ restoring_cache  0:01    │  │  INFO  Cache HIT — key a3f9   │   │
│  │  ─ installing        skipped │  │  INFO  Symlinked node_modules │   │
│  │  ⏳ execute          0:23…   │  │  INFO  Starting wdio runner   │   │
│  │  ─ (pending)                 │  │  INFO  Suite: regression      │   │
│  │                              │  │  PASS  Login flow             │   │
│  │  ┌────────────────────────┐  │  │  PASS  Search                 │   │
│  │  │ ⏳ Running             │  │  │  FAIL  Checkout — timeout     │   │
│  │  │ execute · 0:23 elapsed │  │  │  INFO  Generating Allure...   │   │
│  │  └────────────────────────┘  │  │                        ↓ auto │   │
│  │                              │  └───────────────────────────────┘   │
│  │  [ Cancel run ]              │                                       │
│  └──────────────────────────────┘                                       │
│                                                                          │
│  ── After run completes ─────────────────────────────────────────────── │
│                                                                          │
│  ❌ FAILED  ·  1m 43s  ·  2 passed, 1 failed                            │
│  [ View Allure Report ]   [ View Device Stream ]   [ Retry run ]        │
└────────────────────────────────────────────────────────────────────────┘
```

- Pipeline column: driven by WS events from `/ws/execution/:runId` — state machine, not polling
- Stage shows ✅ done, ⏳ running (with elapsed time), ─ pending, ⏳ skipped (cache hit), ❌ error
- Live log column: SSE from `/api/execution/runs/:runId/logs/stream` — auto-scrolls, virtualised
- Log auto-scroll pauses if user scrolls up; "↓ Jump to latest" button appears
- ANSI colour codes rendered (pass=green, fail=red, warn=yellow)
- After completion: result summary bar + action buttons appear
- `[ View Allure Report ]` opens the served Allure HTML in a new tab
- `[ Cancel run ]` operator+ only; hidden once run is terminal

---

## Screen 6 — Execution Run List

```
┌────────────────────────────────────────────────────────────────────────┐
│  Execution                                          [ + New run ]       │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  [ All statuses v ]  [ All projects v ]  [ All devices v ]              │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  #       Status     Suite        Device      Branch    Duration  │   │
│  │  ──────────────────────────────────────────────────────────────  │   │
│  │  a1b2c3  ⏳ Running  regression  Pixel 8     main      0:43…    │   │
│  │  d4e5f6  ✅ Passed   smoke       Galaxy S23  main      2:11     │   │
│  │  g7h8i9  ❌ Failed   regression  Pixel 7     feature   1:43     │   │
│  │  j0k1l2  🚫 Cancel.  full-suite  iPhone 15   main      0:12     │   │
│  │  m3n4o5  ✅ Passed   smoke       Pixel 8     main      1:58     │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  Showing 5 of 48 runs                           [ Load more ]           │
└────────────────────────────────────────────────────────────────────────┘
```

- Row click → run detail (Screen 5)
- Running rows auto-update status without page refresh (WS or polling)
- Pagination: load-more pattern (not numbered pages) — TanStack Virtual for long lists

---

## Screen 7 — Analytics Dashboard

```
┌────────────────────────────────────────────────────────────────────────┐
│  Analytics                                                               │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  [ Last 14 days v ]  [ All platforms v ]  [ All projects v ]            │
│                                                                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────────┐  │
│  │ Total runs │  │ Pass rate  │  │ Avg duration│  │ Flaky suites     │  │
│  │   342      │  │  78.4%     │  │   2m 14s   │  │  3               │  │
│  │ ↑ +12 vs   │  │ ↓ −2.1pp   │  │ ↓ −8s      │  │  (score > 0.3)   │  │
│  │   prev     │  │   prev     │  │   prev     │  │                  │  │
│  └────────────┘  └────────────┘  └────────────┘  └──────────────────┘  │
│                                                                          │
│  ┌─────────────────────────────┐  ┌──────────────────────────────────┐  │
│  │  Pass rate trend            │  │  Run volume                      │  │
│  │                             │  │                                  │  │
│  │  100%─ . . . . . . .·.     │  │   ██                             │  │
│  │   75%─ ╌╌╌╌╌╌╌╌·╌╌╌╌·     │  │   ██ ██                          │  │
│  │   50%─     ·               │  │   ██ ██ ██  ██  ██               │  │
│  │   25%─                     │  │   ██ ██ ██  ██  ██ ██            │  │
│  │    0%─────────────────      │  │   Aug14  16  18  20             │  │
│  │    Aug 8           Aug 21   │  │   ■ passed  ■ failed  ■ cancel  │  │
│  └─────────────────────────────┘  └──────────────────────────────────┘  │
│                                                                          │
│  Flakiness                                                               │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Suite              Runs   Pass rate   Flakiness score   Trend   │   │
│  │  ──────────────────────────────────────────────────────────────  │   │
│  │  checkout-flow       48    62%         ████░░ 0.41       ↑       │   │
│  │  login-flow          51    94%         █░░░░░ 0.12       →       │   │
│  │  search              50    88%         ██░░░░ 0.19       ↓       │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  Device utilisation          Recent failures                             │
│  ┌────────────────────────┐  ┌──────────────────────────────────────┐   │
│  │ Device      Runs  Pass │  │ Run     Suite       Device  Error    │   │
│  │ Pixel 8      124  81%  │  │ g7h8i9  regression  Pixel 7 timeout  │   │
│  │ Galaxy S23    98  76%  │  │ ...                                  │   │
│  │ iPhone 15     64  74%  │  └──────────────────────────────────────┘   │
│  │ Pixel 7       56  71%  │                                              │
│  └────────────────────────┘                                              │
└────────────────────────────────────────────────────────────────────────┘
```

- All filters URL-synced — shareable, back-button works
- KPI cards: delta vs previous equivalent period (e.g. prev 14 days)
- Charts: recharts `LineChart` (pass rate), `BarChart` stacked (volume)
- Flakiness score bar: filled proportionally to score (0–0.5 range)
- Clicking a flaky suite or recent failure deep-links to run detail

---

## Screen 8 — Servers (Appium server list) — Admin

```
┌────────────────────────────────────────────────────────────────────────┐
│  Appium Servers                               [ + Start server ]        │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  host-01  (Linux · 4 devices online)                                    │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Port   Status     Bound device    PID     Started               │   │
│  │  ──────────────────────────────────────────────────────────────  │   │
│  │  4723   ● Running  Pixel 8         18432   10:04 AM              │   │
│  │  4724   ● Running  Galaxy S23      18891   10:04 AM              │   │
│  │  4725   ○ Stopped  —               —       —         [ Start ]   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  mac-mini-01  (macOS · 2 simulators online)                             │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  4723   ● Running  iPhone 15 sim   9213    9:58 AM    [ Stop ]   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└────────────────────────────────────────────────────────────────────────┘
```

- Grouped by host (MachineHost)
- `[ Stop ]` / `[ Start ]` are operator+ actions
- Admin-only screen — `viewer` role sees this page as read-only (no action buttons)

---

## Screen 9 — Host registration (Admin only)

```
┌────────────────────────────────────────────────────────────────────────┐
│  Register host                                                           │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  On the machine you want to register, run:                               │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  MOBILE_HUB_URL=http://your-server:3000 \                        │   │
│  │  MACHINE_ID=my-host-01 \                                         │   │
│  │  npm run agent                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                          [ Copy ]                        │
│                                                                          │
│  The agent will appear here automatically once it connects.              │
│                                                                          │
│  Waiting for host…  ⠿                                                    │
│                                                                          │
│  [ Cancel ]                                                              │
└────────────────────────────────────────────────────────────────────────┘
```

- Generates the exact shell command pre-filled with the correct server URL
- Page polls (or WS listens) for the new `MachineHost` document to appear; auto-closes on success

---

## Navigation & routing map

```
/                         → redirect to /devices
/devices                  → Screen 1: Device Grid
/devices/:udid            → Screen 2: Device Viewer
/builds                   → Screen 3: Builds Library
/execution                → Screen 6: Run List
/execution/new            → Screen 4: Trigger Run
/execution/new?device=:udid  → Screen 4: pre-filled device
/execution/:runId         → Screen 5: Run Detail
/analytics                → Screen 7: Analytics Dashboard
/servers                  → Screen 8: Appium Servers (admin)
/settings/hosts/register  → Screen 9: Host Registration (admin)
```

All filter state on `/devices`, `/execution`, `/analytics` is URL-encoded (query params). Deep links work.

---

## States every screen must handle

| State | Approach |
|---|---|
| **Loading** | Skeleton placeholders (not full-screen spinner) on all lists and panels |
| **Empty** | Inline empty state with contextual message (e.g. "No devices connected — register a host to get started") |
| **Error** | Inline error with retry; normalized error shape `{ code, message }` — no raw stack traces |
| **Stale / reconnecting** | Visible indicator (banner or badge) — never silently hide degraded state |
| **Unauthorized** | Action buttons hidden per role; if accessed directly → `403` page |
