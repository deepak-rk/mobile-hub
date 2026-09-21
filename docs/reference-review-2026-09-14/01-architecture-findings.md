# Architecture findings

Ranked by confidence. Section 1 is verified against mobile-hub's actual working tree this session — treat as fact. Sections 2–4 are patterns observed in the comparison material, offered as informed hypotheses or design input, not yet checked against our code line-by-line.

---

## 1. Confirmed bugs and gaps (verified against mobile-hub's own code, 2026-09-14)

### 1.1 Device identity is scoped correctly at the schema layer, but not above it

`backend/src/modules/devices/device.model.ts:64-65`:

```ts
// Unique per host — same UDID can exist on different hosts
deviceSchema.index({ machineId: 1, udid: 1 }, { unique: true });
```

The schema explicitly anticipates two different hosts reporting the same UDID (this is the normal case for emulators, whose UDIDs are just `emulator-<port>` — any two hosts running a standard emulator setup will produce colliding UDIDs by default, not as an edge case).

But every device-scoped function in `backend/src/modules/devices/devices.service.ts` queries by `udid` alone, with no `machineId`:

- `getDevice(udid)` → `Device.findOne({ udid })`
- `acquireLock(udid, ...)` → `Device.findOneAndUpdate({ udid, lock: null }, ...)`
- `releaseLock(udid, ...)` → filter `{ udid }` or `{ udid, 'lock.heldBy': userId }`
- `renewLock(udid, ...)` → same shape

And the public route contract in `devices.routes.ts` bakes this in at the API level, not just the service layer: `GET /:udid`, `POST /:udid/lock`, `/:udid/lock/renew`, `/:udid/unlock` — there is no `machineId` anywhere in these routes.

**Consequence:** the moment two real hosts in a mobile-hub deployment report devices with the same UDID, `acquireLock`/`releaseLock`/`getDevice` can silently act on the wrong physical device. This is invisible in the current dev environment because it only ever runs one real host — the collision can't occur with a single machine. It would surface the first time a genuine multi-host deployment hits a UDID collision, which for emulators is close to guaranteed.

**Options (not yet decided — needs a person to choose)**:
- **A.** Change the route/service contract to require `machineId` alongside `udid` everywhere a device is addressed (`/:machineId/:udid/...` or an equivalent). Correct long-term shape; breaking change, touches every frontend call site that currently addresses a device by udid alone.
- **B.** Additive, non-breaking: accept an optional `machineId` disambiguator (query param on reads, body field on lock actions) that narrows the query when supplied, leave the bare-udid path as a documented "best effort, ambiguous if collision" fallback. Ships with zero breakage; only closes the gap once callers actually start passing it.
- **C.** Switch the device identifier used in routes/other models to the Mongo `_id`. Most robust, but the ripple is large — `InstallTarget`, `UninstallTarget`, `StreamSession`, and others all key on `deviceUdid` today.

### 1.2 The identical mistake, smaller blast radius, already has a correct example to copy in the same codebase

`backend/src/modules/execution/appium.service.ts:36`:

```ts
const servers = new Map<string, ManagedProcess>();
```

Keyed by `device.udid` alone (`servers.set(device.udid, managed)` at lines ~148/181). Two devices sharing a UDID across two hosts would collide in this map.

The fix pattern already exists correctly elsewhere in the same codebase — `backend/src/modules/streaming/streaming.service.ts`'s `captureKey(machineId, deviceUdid, protocol)` composes a compound key exactly for this reason. Fixing 1.2 is mechanical once 1.1's approach is decided (same underlying question: what's the disambiguating key for "this device," everywhere).

### 1.3 Execution/Appium orchestration is hub-local only — devices on a remote agent host cannot actually run tests today

`appium.service.ts`'s `ensureAppiumServer()`/`assertDriverInstalled()` (called directly from `execution.service.ts`) spawn `appium` as a **local child process of the hub itself**, unconditionally:

```ts
const managed = supervisor.run({
  command: 'appium',
  args: ['--address', endpoint.host, '--port', String(endpoint.port), ...],
  ...
});
```

`config.appium` (`backend/src/config/org-config.schema.ts:229`) is one single global `{enabled, host, basePort}` — there is no per-`machineId` routing anywhere in this path, and there is no Appium-spawning code anywhere under `backend/src/agent/`.

**Consequence:** for any device attached to a host other than the hub's own machine, the hub would spawn Appium (and Appium would try to spawn adb/xcrun) in a process that has no way to physically reach that device. This is the same root limitation already tracked in `docs/SOURCE_FEATURE_TRACEABILITY.md` for **streaming** ("adb must run beside the device — largest architecture gap") — but it applies to **execution**, which is more central to the product's actual purpose than live viewing is. Given multi-host support is stated as the #1 architectural principle in root `CLAUDE.md`, this means the core "run a test on a device" flow currently only works for devices physically on the hub's own box.

**Recommended fix shape** (built from patterns already proven in this codebase, not a new mechanism):

- Mobile-hub already has a working, tested, three-times-proven pattern: hub records a pending request → agent picks it up on its normal heartbeat poll → agent reports a result on a later poll. This exact shape already exists for installs (`pendingInstalls`), uninstalls (`pendingUninstalls`), and can carry a fourth kind of request the same way.
- Agent gets a small new module that runs the **existing** `appium.service.ts` logic (`ensurePort`/`startServer`/`isServerUp`) inside the agent process instead of the hub process — reuse the already-tested logic, don't rewrite it.
- Agent reports back `{deviceUdid, host, port}` in the same shape as `PendingInstall`/`PendingUninstall`.
- Hub configures wdio's Appium capabilities to point at that remote `host:port` instead of `127.0.0.1:basePort`. Appium is already a client-server HTTP protocol designed for a remote server — no protocol-level change needed, just wiring. Note: today's port-allocation bookkeeping (`ensurePort()`) assigns from one global counter with no host dimension at all, which is fine while every server is local — once remote endpoints exist, whatever tracks "is a server already running for this device" needs to key by `host:port` (or `machineId:port`), not port alone, since two different agent hosts can legitimately reuse the same port number for two different, unrelated servers.
- **Hub-local devices keep using today's code path completely unchanged.** Only the branch for a non-hub `machineId` is new — zero regression risk to the already-working single-machine case.
- This should be treated as **one initiative together with the already-tracked streaming-locality move**, since both need the identical "agent runs a local process for a device, reports back a reachable endpoint" primitive. Building the primitive once and using it twice is less total risk than building it twice.
- **Validate without needing real second hardware**: run a second agent process on the same dev box with a distinct fake `machineId` (the exact trick already used this session to validate install/uninstall against a real emulator), pointed at a different Appium port. This fully proves the routing/relay/endpoint-composition logic. Only genuine cross-machine adb reachability is untestable on a single box — an environment limitation, not a design gap.
- Ship behind a feature flag with today's hub-local path as the default, rather than a hard cutover — mirrors a rollout discipline observed in the comparison material's own fix log for its equivalent risky rearchitectures (each shipped opt-in, with the old path preserved as rollback, before becoming default).
- Once the agent reports an endpoint back, don't treat "reported" as "ready" — retry the health check with backoff before the hub actually points a run at it. The comparison material has an explicit stage for exactly this shape of problem on a different (physical-device) path: waiting for a device-readiness signal to stabilize, with retries and backoff, before touching anything that depends on it being ready — silent failures downstream were the cost of skipping this. Mobile-hub's own `appium.service.ts` already has the right instinct here (`isServerUp`/retry-then-adopt) for the hub-local case; the same discipline needs to survive the hop across the hub→agent boundary.

**A general principle worth keeping in mind for this whole initiative**: the comparison material's own fix log includes an explicit "hub-parity" fix — a case where their agent-side path had silently drifted to support *less* than the hub-side path for the same nominal operation (fewer permission categories granted, in their case) until an audit caught it. Whenever mobile-hub builds a capability that exists on both the hub and the agent (which this whole initiative is about to do for Appium), it's worth deliberately auditing that the agent path has full parity with the hub path, not a silently-reduced subset — that's an easy drift to introduce by accident and an easy one to miss in review, since both paths "work," just not equally.

### 1.4 The agent's own download from the hub has no integrity gate — verified

`backend/src/agent/hub-client.ts`'s `downloadArtifact()` streams straight to the final `destPath` via `fs.createWriteStream(destPath)` — there is no temp-file-plus-atomic-rename (no `.part` staging), and `backend/src/agent/installer.ts:240` reads `fs.statSync(destPath).size` afterward only to report *push-to-device* progress, never to assert it matches the expected size (`sizeBytes`/Content-Length) before proceeding to install.

This is the asymmetric half of an otherwise-correct picture: the **hub's own** fetch from a `BuildProvider` already has a real integrity gate (size + sha256, tracked as DONE in `docs/SOURCE_FEATURE_TRACEABILITY.md`'s Builds section). The **agent's** fetch of that same artifact from the hub does not have an equivalent gate. Node's `pipeline()` will usually throw on a hard connection failure mid-stream, so this is partially self-defending against the most common failure mode — but there's no explicit defense-in-depth check for a connection that closes early yet still looks superficially "done" (e.g. a truncating intermediary). This is exactly the failure class root `CLAUDE.md`'s own "lessons carried in" section names directly: *"Zip/artifact download integrity needs validation before 'done', not after a support ticket."*

Fix shape, if pursued: write to `<destPath>.part`, validate final size against the expected value (the hub already tells the agent `sizeBytes`), atomic-rename to the real path only on success, reject and clean up on a mismatch — the same shape already used correctly on the hub's own provider-fetch path.

### 1.5 The execution pipeline's own stage model is narrower than the comparison system's, and orphan recovery doesn't close the Appium session it may have opened — both verified

`backend/src/modules/execution/execution-run.model.ts:10` — `StageName` is exactly `'pulling' | 'restoring_cache' | 'installing' | 'execute'`. There's no distinct, user-visible stage for "collecting/summarizing results" or "releasing the device and cleaning up" — that work happens after `execute` completes, but isn't its own observable stage with its own status/duration. A user watching a run's stage table has no signal if result-collection is slow or silently failing; it looks identical to "still executing."

Separately, `recoverOrphanedRuns()` and `cancelExecutionRun()` (`execution.service.ts:638-650, 738-755`) both release the device lock and mark the run's stage as errored, but neither calls anything in `appium.service.ts` to close the specific WebDriver **session** that run may have opened. This matters because Appium servers here are long-lived, one-per-device processes (adopted across many runs, not restarted per run) — so an abandoned session inside that persistent server isn't cleaned up by killing the run's OS process tree; the server process (and whatever session state it's holding) lives on. The next run against that device creates a new session against a server that may still be holding the orphaned one, which for most mobile drivers only support one active session at a time is a real, if not yet observed in practice, source of a confusing next-run failure.

Neither of these is necessarily worth fixing in isolation — both are natural companions to whatever work eventually adds an agent-side Appium module (finding 1.3): that module is the right place to also expose "terminate the session for device X" as an explicit operation the hub can call during orphan recovery, and to consider whether post-execution/release deserve to be their own visible stages.

---

## 2. Architecture patterns already correctly built in mobile-hub (validated by comparison, not new work)

- **Device identity model** — compound `{machineId, udid}` at the schema layer is exactly right, and matches a hard lesson the comparison material's own team had to learn the hard way. It only needs the follow-through described in 1.1/1.2.
- **Agent-poll, never-pushed-into transport** — the "hub records pending work, agent discovers it on its own heartbeat, agent reports back" pattern already used for installs/uninstalls is the same shape the comparison material converged on independently for its own build-download and stream-viewer-request flows, for the same reason: it works through firewalls that would block anything pushed *into* an agent, since the agent always initiates.
- **Explicit device lock state, not inferred from execution logs** — already built. Notably, an accurate "is this device idle/in-use" indicator was still an open, high-priority item in the comparison system at the time of its own review — direct validation that building this in from day one (rather than retrofitting it later) was the right call, and specifically why finding 1.1 is fixable in design rather than needing a production incident to surface it first.
- **Auth/RBAC scoped from day one** (role-based access, per-agent revocable credentials) — the comparison system was still only planning its equivalent (centralized SSO/audit) as a future milestone at review time.

---

## 3. A real, generalizable architecture pattern worth adopting: two-path build distribution

The comparison material distinguishes two paths: "download a build to the hub's own disk, for hub-local devices" versus "tell the agent to download the build directly from its original source, never proxying bytes through the hub, for agent-owned devices." The second path is specifically what makes a deployment where agents sit behind restrictive networks workable at all — the hub only orchestrates, it never becomes a bandwidth bottleneck or a single point of failure for large transfers.

Mobile-hub's current artifact flow only has the first path — an agent always fetches a build via the hub's own `GET /api/builds/:id/artifact`. This is a real, generic (not organisation-specific) architecture improvement worth considering once `BuildProvider` grows a second real implementation: let the agent fetch directly from the provider's own source URL when it's reachable, falling back to hub-proxied bytes otherwise. The shape generalizes cleanly — it isn't tied to any specific artifact-repository product.

A concrete implementation technique observed for the related "changelog" capability (already tracked as ADAPT, downstream of provenance, in the traceability doc): a **negative cache with a short TTL on failed commit/changelog lookups**, paired with a background refresh that has its own cooldown and in-flight-request deduplication. Worth reusing whenever that capability is actually built — it's what keeps a build list responsive even when the underlying source-control lookup is slow or transiently failing, without either blocking the list or hammering the same failing lookup on every page load.

A smaller, related idea observed alongside it: **agent-side build caching** — keep a previously-downloaded build on the agent's own disk, keyed by build id, so a repeat install of the same build onto another device on the same host skips re-transferring it entirely. Low-risk, clearly valuable, worth adding whenever agent-side download logic is next touched.

---

## 4. Gotchas worth designing around before adding the relevant metric/feature (not yet built here, flagged for later)

- **CPU%/RAM are commonly measured wrong with naive OS APIs.** A load-average-based CPU metric can misreport a genuinely idle machine as near 100% busy (load average is a queue-length metric, not a percentage). `os.freemem()`-style APIs can under-count reclaimable/purgeable memory on at least one major OS. Whenever host diagnostics grow a CPU/RAM figure (already flagged elsewhere in the traceability doc as a partial gap), verify the number against a genuinely idle real machine before trusting it, on every OS mobile-hub targets — the comparison material's own fix log shows this exact mistake shipped to production and had to be corrected later.
- **A registry of live child processes kept only in a process-memory `Map`/`Set` is invalidated by any restart.** Anything that "adopts" an already-running process by probing it needs to treat "the port is held but not answering yet" as a *third* state, distinct from "free" and "ready" — mobile-hub's own `appium.service.ts` already handles this correctly (`isServerUp`/retry-then-adopt logic); worth keeping as an explicit design rule for the agent-side Appium module proposed in finding 1.3, and for any similar future adoption logic.
- **Deregistering a host/agent needs an explicit "blocked" marker, not just a record delete** — otherwise the next heartbeat from that same `machineId` silently recreates the record and the deregister action becomes meaningless. Relevant the moment the already-open "remove a host" TODO item gets built.
- **A startup sequence that accepts HTTP traffic before an in-memory cache/registry is actually warm can produce a burst of duplicate or incorrect work right after a restart**, when many callers that were waiting/retrying all reconnect within the same window. Worth a deliberate check of mobile-hub's own boot sequence if/when real deployments grow past a handful of agents.
