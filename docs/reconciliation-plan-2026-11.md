# Reconciliation plan — learnings from a production device farm (2026-11-21, rev 2)

**Source.** A 6-page architecture reverse-engineered from a production mobile device farm in this same domain: ~1,090 non-merge commits over four months, 76 numbered lessons, a 15-row critical-failures ledger, fix-on-fix chains, replacement chains, an adoption timeline and an open-issues list. **Only architecture and lessons are carried in** — no organisation, host, repository, product, brand or people names.

**Mockups.** `docs/mockups/before-after.html`.

**Revision 2.** Rev 1 was written from a half-resolution read of the photos with four of six pages upside down. It got the gist and missed most of the detail. Rev 2 comes from a verbatim transcription of every box (54 native-resolution tiles), cross-checked against this repo's code. §0 records what rev 1 got wrong.

---

## 0. What rev 1 missed or got wrong

| Rev 1 said / omitted | Reality |
|---|---|
| "Runner env is ad-hoc" | Wrong. `run-environment.ts` already injected `APPIUM_HOST/PORT/BASE_URL`, `DEVICE_UDID`, `PLATFORM`, `PLATFORM_VERSION`. The real gaps were narrower: **no base path**, **configured env overrode per-run values**, no `AUTOMATION_NAME`/`RUN_ID`. |
| Listed farm "rules" as advice to adopt later | 13 of them were **live bugs in this code**, found by checking each against the source. All fixed in `e2d4507` (§2). |
| Omitted the failure ledger's lesson that *outcomes are the hardest thing to keep correct* | The farm's outcome ("pass") was destroyed by four separate writers over three months (§1). This repo had three of the four. |
| Omitted concurrency guards, cache atomicity, zero-test detection, run timeouts, stale-results clearing, raw-results persistence, emulator boot gating, debounced device eviction | All present here as bugs or gaps — §2, §4. |
| Omitted the "a fix that was not the last fix" chains | Six documented chains (TLS override, results copy, health timeouts, CPU metric, log transport, device identity). Each teaches "verify the fix against the real failure, not the symptom". §5. |
| Proposed "one app per deployment" without noting the farm itself is mid-way to multi-project | The farm has multi-project design docs (last week of its history) and multi-entity execution groups. The decision stands, but the model must keep `app.id` stamped on every run/build so multi-app is additive later (§6). |
| Did not separate what this repo already does *better* | §7 — auth/RBAC, per-agent credentials, compound device identity from the first schema, shared-capture streaming. |

---

## 1. The central lesson: keeping a recorded outcome correct

The farm's ledger shows a single "pass" being turned into a "fail" by four different writers, each found and fenced separately:

1. **Cleanup deleted the results** before they were read (results lived inside the per-run checkout).
2. **A reporting error skipped the status update** (the update sat inside the report's try block).
3. **Restart recovery marked every interrupted run failed** — including runs whose results were already on disk.
4. **A duplicate worker** re-ran a finished run; its setup failure overwrote the real pass.

Its fix set is now: results persisted first · status update always runs · repair from saved results · atomic claim · late-failure guard. This repo had (1)-equivalent (raw results never persisted), (3)-equivalent (blanket recovery, no repair path), and the precondition for (4) (non-atomic writes) — fixed in §2 except the repair path, which is Phase 2.

---

## 2. Bugs fixed in this pass (commit `e2d4507`, 428 tests, each with a regression test)

| # | Farm lesson / incident | Bug here | Fix |
|---|---|---|---|
| 1 | Duplicate worker overwrote a pass (critical) | Status writes were read-modify-`save()`; a cancel racing the dispatcher was lost while the run executed; a late failure could overwrite a pass | Atomic `queued→preparing` claim; conditional cancel; `setStatus` refuses to leave a terminal status and unmarks the path so a later `save()` cannot replay a stale copy |
| 2 | Zero-test detection | Exit 0 with zero tests → `passed` | Results dir present but empty → failed (precondition) |
| 3 | Results deleted with the checkout (critical) | Raw `allure-results` read in place, then deleted | Copied **whole** (attachments too — the farm's narrower copy lost steps and screenshots) to durable artifacts before anything else in cleanup |
| 4 | Wrong results shown | Results already in the checkout counted as this run's | Results/report dirs cleared before execute |
| 5 | Cleanup poisoned the npm cache (critical) | Direct copy into the final dir; hit = "dir exists" | Temp dir + completion marker + rename; unmarked dir = miss, replaced |
| 6 | Max run duration + stale-run sweep | No timeout on the test command | `EXECUTION_MAX_RUN_MINUTES` (120) |
| 7 | Agent offline → fail fast | Runs on a long-offline device queued forever or died slowly at Appium startup | Fail as precondition after 2 min offline, at trigger and in the dispatcher |
| 8 | Install job queued > 3 min with agent offline → fail | Queued install/uninstall targets waited forever | Failed with reason when the host has been offline > 3 min |
| 9 | Cancel semantics | Cancelling a run not executing in this process did nothing and leaked | Ownership tracked; an orphan is cancelled directly |
| 10 | Devices vanished on one failed probe (lesson 56) | One failed `getprop` dropped the device → hub marked it offline **and released its lock under a running execution** | Last-good record; 2-poll eviction grace; emulators only after `sys.boot_completed=1`, sticky |
| 11 | Global base-path cache 404'd every remote run (critical) | `/wd/hub` resolved for health checks, dropped before the runner | Path carried on the endpoint; `APPIUM_PATH` + full `APPIUM_BASE_URL` injected |
| 12 | Workspace env kept a hardcoded remote host (lesson 21) | Org-wide configured env overrode per-run `APPIUM_HOST`/`DEVICE_UDID`/`PLATFORM` | Per-run values always win; `AUTOMATION_NAME`, `RUN_ID` added |
| 13 | Credentials in example env (security) | Placeholder `JWT_SECRET`/`AGENT_TOKEN` passed length checks → a verbatim copy ran production with a public signing key | Refused in production |
| 14 | ~98 % of the log was access logs | Agent heartbeat/sync/frames/progress at `info` (~800k lines measured) | Agent routes log at `warn` |

Not live-verified: Docker/Mongo was down this session. First thing once it is back (§8).

---

## 3. Model & config corrections (decided; Phase 1)

1. **One app per deployment.** Trigger form has no project picker. The `/execution/projects` endpoint stops folding run-history strings into the selectable list (that is the source of the "multiple projects" seen in the form). **Done (2026-11-22):** the form offers declared projects only and shows a single one read-only. Deviation: the endpoint still lists history names, because the analytics filter needs them for past runs; the form filters instead.
2. **Platform is a run input**, not a project property. An app declares `platforms: [android, ios]`; build and device lists follow the run's platform. **Done (2026-11-22):** `platforms` (legacy `platform` still read); the device picker filters by it and a trigger on another platform is a 400 `PLATFORM_NOT_SUPPORTED`. The form has no build picker, so there is no build list to filter yet.
3. **Variant** (the farm's "entity") as an optional run dimension: `variants:` in app config → picker + `VARIANT` env. The farm also derives tags from it and groups executions by platform × variant — adopt both when the runner status tree lands. **Done (2026-11-22)** except the derived tags and grouping (Phase 3): picker, `VARIANT` env, stored on the run, copied by rerun; required when declared, rejected when not.
4. **Config split**: org file = platform concerns; app file = the app, its platforms, variants, automation repo, runner env. Per-host Appium wiring leaves YAML (agent env; the hub stores the reported endpoint per device — already does).
5. ~~`framework` → `runner` + `framework`~~ **Done** (legacy `framework: appium` still loads as wdio + cucumber); driver derived from platform (done in the env).
6. ~~Remove the dead `envFile` key~~ **Done** (now a config error, not silently ignored).
7. **Seed config from code, prove it with a golden diff** (farm lesson 72: config written from summaries had ~30 wrong values). Any example YAML in this change is copied from the schema with file:line references and checked by a test that loads it. **Partly done:** both example files load through the real loader in a test.

---

## 4. Capabilities to build (phased)

### Phase 2 — execution correctness (what remains after §2)
- **Repair from saved results** (`resync`): rebuild a run's outcome from its persisted raw results; restart recovery uses it instead of a blanket "failed" when results exist. Repair only — never fails anything for absence. **Done 2026-11-22:** restart recovery uses it (already-failed tests stay `test`/`test_assertion`; a run is never called passed after a restart), and `POST /api/execution/:id/resync` re-derives a finished run (live-checked).
- **errorClass** taxonomy: `device_offline · install_failed · test_assertion · network_timeout · appium_session · build_missing · cancelled · unknown` (keep `failureKind` as the attributable/non-attributable projection). **Done 2026-11-22.** Deviation: five classes added because real failure points had no home and would all read `unknown` — `checkout_failed`, `dependency_install_failed`, `no_tests_matched`, `run_timeout`, `hub_restarted`. `install_failed` is produced by the app preflight stage (added 2026-11-22).
- **App preflight** stage: is the bundle on the device? else wait for any in-flight install on that device → download + install → re-verify. Fail-fast `install_failed`/`build_missing`. Resolve the device by host + udid. **Done 2026-11-22** (`app-preflight.ts`, stage `app_preflight`, class `install_failed`). Deviation: "on the device" is read from the hub's install history, not from the device (the hub has no adb to it); an app removed by hand still reads as installed, and the runner's `app` capability stays the backstop.
- **Prep semaphore**: bound concurrent dependency installs per hub (farm: 3; parallel npm installs peak 1.5–3 GB RSS each). **Done 2026-11-22** (`EXECUTION_PREP_CONCURRENCY`, default 3; waiting is logged and cancellable).
- **Bare repo + worktree per run** with a fetch mutex and stale `.git/*.lock` cleanup; boot prune of orphaned worktrees keeps logs and results. **Done 2026-11-22** (`repo-checkout.ts`; branch now validated at trigger; live-checked).
- **Stage model**: add the result-collection/release stage already recorded as REIMPLEMENT. **Done 2026-11-22** (`collecting` stage; live run: 8 s of cleanup now visible).
- **Executor field** on every run (`{ kind: 'hub' | 'agent', machineId }`) for the scale path. **Done 2026-11-22** (`executor: {kind: hub, machineId: HUB_MACHINE_ID}`, default hostname).

### Phase 3 — execution visibility
- **Runner status tree**: execution group (platform × variant, shared group id) → suite → feature → scenario/outline row; each node `status, runId stamp, updatedAt, rerunHistory`. Writers and rules exactly as the farm learned them:
  - `markRunScenarios` (schedule / executing / prep failure) — `failed` never overwrites this run's completed/failed.
  - `updateFromResults` (run end) — newest result per name by stop time (retries), passed/skipped → completed, failed/broken → failed, leftover executing → failed.
  - resync — repair only.
  - live log parser — in-flight state from the run log; **never return a capped parse as final** (lesson 60).
  - Bubble-up precedence: running → executing · scheduled/queued → scheduled · all ready → ready · all completed → completed · all failed → failed · else partial.
- Rerun failed-only, rerun with comment (history), bulk rerun/cancel, "clear stuck" (reset to ready). **Failed-only done 2026-11-23** (`rerun-selection.ts`; selection by feature file + exact scenario name; refused, not widened, when a failure cannot be pinned down; failed-only reruns left out of analytics outcome queries, kept in device utilization). Rerun comment done 2026-11-23 (`rerun.comment`). Bulk rerun/cancel done 2026-11-23 (`/bulk/rerun`, `/bulk/cancel`, a result per id). Clear-stuck still open.
- Combined per-execution report: merge + dedupe by history id; failure evidence = screenshot of the **failing step**, not the first image (lesson 61). **Failure evidence done 2026-11-22** (`failureEvidenceOf`, `GET /:id/evidence/:file`, Failed tests list); the combined report is still open.
- Count summaries always include broken and total (lesson 65). **Done 2026-11-22** (total now visible on the run page).

### Phase 4 — device interaction & device config
- Remote control (tap/swipe/type, home/back/rotate), screenshot, reboot, reconnect, wipe/reset — agent-pulled jobs.
- **Device-config jobs**: durable Mongo record (queued → running → succeeded | failed | timed-out | interrupted, 24 h TTL), late results accepted, result route keyed on the durable id (lessons 42–44); `dryRun`, Idempotency-Key, refuse production environments.
- **One busy-lock key for one phone** across app-setup, device-config, install and execution — derived from the resolved owner (lesson 41: two guards keyed differently never saw each other).
- Post-install setup: permissions and env flags. Device tooling quirks to design in from the start:
  - `pm grant` of an undeclared permission exits 0 and does nothing → **read state back** (`dumpsys package`) (lesson 36).
  - Some permission classes cannot be granted → `skipped`, not `failed` (lesson 39).
  - `pm list packages x` is a prefix match → compare the exact line; substring ≠ identity (lesson 29).
  - simulator privacy/plist: correct on disk ≠ reloaded — the shell must restart (lesson 64).
  - `adb screenrecord`: one per physical device → shared bus.
- Device state (simulator): appearance, orientation, text size, location, biometrics.

### Phase 5 — fleet & ops
- Agent registry with `blocked` tombstone; deregistration survives the next heartbeat.
- **Machine identity**: `MACHINE_ID` env → OS machine id → persisted file → hostname hash, same algorithm on hub and agent.
- **Single-instance guard keyed on identity, never on a port** (lesson 40: a port fallback defeated it and two agents at different commits fought).
- Heartbeat payload with `protocolVersion`, system metrics (sample CPU twice — a single sample is a since-boot average), capabilities, and a pushed device-health snapshot (served from the snapshot, not live probes through proxies).
- Fleet view: per-agent version vs hub, RAM/CPU/disk bars, the hub shown as a host not an agent.
- Scheduler: 60 s tick behind a **server** flag (a client flag leaves the timer firing — lesson 57); each fire claimed by atomically advancing `nextRunAt`; self-contained targets re-derived on edit (lesson 68); conflict guard (same device within 30 min → 409); update allow-list (never `$set` a raw body); pre-warm the app 30 min ahead, skip busy devices.
- Notifications (run completed/failed, device offline/busy/released) and an activity log. **Anything a progress panel shows must have its own job record** (lesson 52); never coerce "no measurement" to 0 % (lesson 53).
- Resumable build downloads (Range, retries, stall window) on agents; a verify that fails or returns empty is **unknown**, never "not installed" — never delete install records on absence of evidence.

---

## 5. Fix-on-fix chains — the meta-lesson

| Area | First fix | Why it was not the last |
|---|---|---|
| Heartbeat transport | Disable keep-alive / custom agent for "socket hang up" | Replaced the enterprise TLS agent → every heartbeat failed cert checks for 25 days |
| Results copy | Persist before cleanup | Then narrowed to result JSON only → lost steps and screenshots |
| Health timeouts | Raise timeouts | Reverted to fast-fail; real fix: serve a pushed snapshot |
| CPU metric | `top` idle % | That is a since-boot average → sample twice |
| Log transport | SSE | Proxy buffering showed "0 lines" → flush hack → REST tail |
| Device identity | udid → udid+host → udid+machineId → cache keys → preflight lookups | Legacy unique index still colliding |

Rule: a fix is verified against the **failure it addresses, reproduced**, not against the symptom disappearing. Most of this repo's own last nine bugs were the same shape (`docs/LESSONS.md`).

---

## 6. Decisions (2026-11-21)

1. **One app per deployment.** Stamp `app.id` on every run/build so multi-app stays additive (the farm itself is starting multi-project).
2. **Variant as an optional run dimension**, added in Phase 1.
3. **Runners on the hub**, scale path recorded: `executor` on every run from day one; per-executor prep semaphore; move to agent execution when the hub's concurrent-run ceiling or the hub→agent Appium network path is the bottleneck, via the existing pull model.
4. **Model first, then features**, each phase live-verified on real hardware.

## 7. Keep — where this repo is already ahead

- Real end-user auth and viewer/operator/admin RBAC (the farm has none; it is its top open risk).
- Per-agent revocable credentials (the farm uses one shared secret).
- Compound `{machineId, udid}` uniqueness from the first schema (the farm still carries a legacy bare-udid index).
- Shared-capture streaming, agent-local capture, JPEG, backpressure.
- Durable artifacts split from the ephemeral workspace; boot orphan recovery for runs, builds and stream sessions.

## 8. Next actions

1. **Live-verify §2** once Docker is back: a real run (claim, results persisted, zero-test path with a non-matching tag), a cache snapshot interrupted mid-copy, an `adb` blip during a run (lock must survive), a placeholder-secret production boot (must refuse).
2. Phase 1 (§3), ending with a real Android run from the new trigger form.
3. Rules from the farm already enforced by this pass go into `backend/CLAUDE.md` once Phase 1 lands (atomic transitions; never overwrite a terminal outcome; unknown ≠ none; temp + rename for shared caches; per-run env always wins).

---

## 9. Gaps found by the accountability pass (`docs/accountability-2026-11.html`)

Items that apply here but were in neither this plan nor the code. Ordered by risk.

**Correctness / safety**
1. Installs skip the device lock, so an install can land on a device mid-run (farm Lesson 41, "never install over a busy device"). **Recorded earlier as a deliberate decision** (`install-run.model.ts:86`); the farm's data argues for revisiting it. Awaiting a decision.
2. ~~Feature switches do not stop server timers~~ **Done `4359c4f`.** The toggles were never read at all; routes and timers now honour them; `98b48b3` hides switched-off modules in the frontend too.
3. ~~`AGENT_APPIUM_HOST` loopback default~~ **Done `4359c4f`:** a loopback report from a remote request uses its source address.
4. ~~CSP is disabled~~ **Done `50a2bd7`** (per-route policies); `33841d9` lets the sandboxed report fetch its own data in production.
5. ~~No CI workflow~~ **Done `88f19e9`** (backend on ubuntu + windows, frontend); green on every push since `3f90f0c`.

**Execution**
6. npm install: one ETARGET retry, fetch timeouts; load check that invalidates a bad cache entry; seed from the nearest complete entry on a miss.
7. Shared (server-side) execution presets — per-browser presets exist; test impact from git diff; CSV export; artifacts zip; KPI gauges.

**Devices / fleet**
8. Stream concurrency cap and staggered capture starts.
9. verify-requests (list installed bundles from the agent, unknown ≠ none).
10. Agent build pre-staging; device-health page. (A multi-device view already exists.)
11. Agent service install, self-update/deploy with rollback, SHA256 tarball installer; physical iOS install target.
12. Log the source of SIGTERM.

**Docs / process**
13. Reverse-proxy note: SSE must not be buffered (`X-Accel-Buffering: no`).
14. Symptom → check → fix and log-line → cause runbooks.
15. Add "review by feature, by artefact, by user journey" to `docs/SELF_REVIEW.md` (Lesson 73).
16. Frontend: lazy routes; runtime override for client feature flags (Lesson 59).

**Found by the 2026-11-22 verification and device-level pass — all done:** suites follow the chosen branch (`f137197`), the form starts on the remote default branch (`b69330d`), branch checkouts are de-duplicated and pruned (`8e5d68d`); trigger picker and presets keyed by host (`a0e7afc`); install notes shown as "Done with warning" (`f137197`, tested `495e794`); cancel during cache restore (`ecc6324`); `stop.mjs` orphan watchers (`acd8c4a`); backend healthcheck (`361e234`); emulator stability (`16a7aed`).

The Unverified rows were all resolved by a code check (`3466d8c`).
