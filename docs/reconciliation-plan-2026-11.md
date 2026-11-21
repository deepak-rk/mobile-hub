# Reconciliation plan — learnings from a production device farm (2026-11-21)

**Source.** A 6-page architecture reverse-engineered from a production mobile device farm (~1,090 commits over four months, 76 numbered lessons, a 15-row critical-failures ledger). Per the standing rule, **only architecture and lessons are carried in here** — no organisation, host, repository, product or brand names.

**Mockups.** `docs/mockups/before-after.html` — before/after for the trigger form, config, run pipeline, run detail, device page and backend flow.

**Status.** Analysis + proposed plan. Nothing in §3–§4 is implemented yet. §6 lists the decisions that block it.

---

## 1. Self-reflection — where this repo went wrong, and why

The honest pattern across the last several sessions: **this repo optimised for breadth of features over correctness of the core model, and declared things done on the evidence of tests and diffs rather than the running system.** Nine real bugs were found in the last bug-hunting pass alone, every one in code the docs called done (see `docs/LESSONS.md` 2026-09-21 → 2026-09-23). The farm's own ledger shows the same arc — its worst bugs were all "silent ones: nothing failed loudly, it was just slow or wrong" — but it got there by running a real fleet; this repo kept adding features on top of an unverified foundation.

Three modelling mistakes sit underneath the specific problems you raised:

1. **"Project" was modelled as a free-form, plural, run-history-derived thing.** The trigger form's project list is `declared projects ∪ every distinct ExecutionRun.project ever written` (`execution.routes.ts` `/projects`). Anything that ever reached the API — a test-suite fixture name, a typo, an ad-hoc call — becomes a permanent, selectable "project". That is the multi-project picker you saw. The farm has exactly **one** app under test per deployment; everything else is a dimension of a run, not a project.
2. **Platform was attached to the project, not the run.** `projects.<id>.platform: android | ios` makes a cross-platform app into two "projects" (the example YAML literally declares an Android one and an iOS one). In the farm, platform is a **run input** (`PLATFORM` env to the runner) alongside entity/variant, suite, tag, device and build.
3. **The two-file config layering is muddled.** `mobilehub.org.yaml` + `mobilehub.project.yaml` were meant as org-defaults + per-project overrides, but the merge is document-wide, so `project.yaml` is really just a second global layer — it currently carries a `projects:` *map* and an `appium:` block (a per-host concern). The farm keeps host/agent wiring in agent env (`APPIUM_HOST`, base path per host:port) and app/run concerns in the app config.

## 2. Specific YAML problems (current `mobilehub.project.yaml` + schema)

| Problem | Evidence | Correct shape |
|---|---|---|
| File named "project" declares many projects | `projects:` map in `mobilehub.project.yaml` | One app per file; the file *is* the project |
| `platform` per project | `platform: android` | Platforms the app ships on: `platforms: [android, ios]`; chosen per run |
| `appium.host/basePort` in project config | `appium:` block | Per-agent env / host config; hub stores reported endpoint per device (already does via `remoteAppium`) |
| `framework: appium` | conflates runner with driver | `runner: wdio` (+ `framework: cucumber`), driver derived from platform (`UiAutomator2` / `XCUITest`) |
| `envFile` dead key | already marked DROP in traceability | remove from schema + example |
| No variant/entity dimension | — | `variants:` list (optional) feeding a `VARIANT`/`ENTITY` env var to the runner |
| No declared run env contract | runner receives ad-hoc env | Explicit, documented env contract (see §4.3) |

## 3. Things to correct (existing behaviour that is wrong)

1. **Project picker pollution** — stop folding run-history project strings into the selectable list. History stays queryable; the picker shows configured project(s) only.
2. **Platform moves from project to run** — add `platform` to the trigger input and run snapshot (snapshot already records it); build/device filters follow the run's platform.
3. **Config file split** — one org/platform file (features, providers, retention, RBAC defaults) + one app/project file (the app, its platforms, variants, automation repo, run env contract). Host wiring leaves YAML entirely.
4. **`framework` semantics** — split runner vs driver as above.
5. **Failure taxonomy is too coarse** — `failureKind: test | infra | precondition` → the farm's `errorClass` set: `device_offline, install_failed, test_assertion, network_timeout, appium_session, build_missing, cancelled, unknown`. Pass-rate attribution keeps working (map test_assertion → attributable).
6. **Stage model too coarse** — already recorded as REIMPLEMENT (no result-collection / release stage). Farm stages: `queued → pulling → restoring_cache → installing → [app preflight] → executing → completed | failed | cancelled | partial`.
7. **Full `git clone` per run** — replace with one bare repo + `git worktree` per run (farm: fetch mutex over a shared bare repo, worktree per run, removed in cleanup). Faster, less disk, same isolation.
8. **Runs are not stamped/claimed by hub identity** — the farm's single biggest class of incident (stolen runs, double execution) came from two hubs on one database. Add `ExecutionRun.claimedBy` (hub machineId) with an atomic `queued → pulling` claim; a hub only processes runs it claimed.

## 4. New capabilities to implement (from the farm)

### 4.1 Execution
- **App preflight** stage: before executing, ensure the requested build is installed on the target device (install if missing), fail fast with `build_missing`/`install_failed`.
- **Runner status tree**: live suite → feature → scenario (→ outline row) status, parsed from the runner log during the run, reconciled against Allure at the end. Replaces "Execute suite: running" with real progress.
- **Rerun failed-only** and bulk rerun/cancel.
- **Scheduler**: cron-like scheduled runs with a single atomic `nextRunAt` claim (farm lesson: two hubs firing one schedule twice).
- **Prep semaphore**: bound concurrent installs/npm work per hub (farm default 3).

### 4.2 Device interaction (currently view + lock + install only)
- Remote control from the live view: tap, swipe, text input, home/back, rotate.
- Device ops: screenshot, reboot, reconnect, wipe app data, uninstall/verify.
- Device state: appearance (dark/light), orientation, text size, location, biometrics (simulator), via a device-config job the agent pulls.
- All of it agent-pulled (the existing heartbeat-relay pattern), with durable job records and late results accepted.

### 4.3 Runner environment contract
One documented env set the runner always receives: `PLATFORM, VARIANT, UDID, RUN_ID, RUN_SUITE, RUN_TAG, AUTOMATION_NAME, APPIUM_HOST/PORT/PATH, BUILD_PATH`. Configured `automation.env` layered on top (already allow-listed + redacted).

### 4.4 Fleet
- Agent registry with `blocked` tombstone, so a deregistered agent can't silently reappear on its next heartbeat.
- Agent liveness fail-fast: a run against a device whose host hasn't been seen in N minutes fails immediately as `device_offline`, not after a timeout.
- Persisted machine identity on the agent (env → OS machine id → persisted file → hostname hash), same algorithm on hub and agent.

### 4.5 Reporting & ops
- Combined per-run Allure single-file report (generated, not just parsed).
- In-app notifications (run completed/failed, device offline, install failed).
- Activity log for device/build/run actions.

## 5. Rules to adopt (generalised from the farm's 76 lessons — most map to bugs already hit here)

1. Every write carries `machineId`; every read filters on it. Recyclable serials (emulators) are identified by `machineId:udid`, never bare udid.
2. Two guards over one resource must derive the same key from the resolved owner.
3. Work that happens outside your process: persist its record, accept late results, never treat "in-memory job gone" as "job failed".
4. A remote device's install/readiness state round-trips to its agent or is `unknown` — never inferred.
5. In a pull model only the hub can stop a retry: every terminal endpoint handles `status: error`.
6. An empty or failed verification is "unknown", never "not installed" — never delete records on absence of evidence.
7. Atomic claims (`findOneAndUpdate` on expected state) for every state transition two workers could race on; cancel is guarded with `$ne: cancelled`.
8. Late-failure writers must not overwrite a terminal result (the farm's "a pass turned into a fail" class).
9. Feature switches exist at both layers (server + client) or the UI shows controls the server refuses.

## 6. What this repo already does better — keep

- Compound `{machineId, udid}` uniqueness from the first schema (the farm still carries a legacy bare-udid index).
- Per-agent revocable credentials (the farm uses one shared secret).
- Real RBAC with viewer/operator/admin (the farm has no end-user auth).
- Shared-capture streaming fan-out, agent-local capture + JPEG, backpressure.
- Durable artifacts split from the ephemeral workspace; boot-time orphan recovery.

## 7. Decisions (made 2026-11-21)

1. **Project model → one app per deployment.** A deployment tests one mobile app that ships on Android and/or iOS. No project picker; platform, variant, suite/tag, device and build are run inputs. Supersedes the earlier multi-project `projects:` map.
2. **Variant → optional run dimension, added now.** Optional `variants:` list in the app config; when declared the trigger form shows a picker and the runner receives `VARIANT`. Apps that declare none see no change. (Supersedes the earlier "Entity indefinitely deferred" disposition.)
3. **Run locality → on the hub, with a planned path to scale.** Hub runs the runner; WDIO dials the device's agent-hosted Appium for remote devices (current design). Scalability path, *not built now*, but the model must not foreclose it:
   - A run records **where it executes** (`executor: { kind: 'hub' | 'agent', machineId }`) from day one, defaulting to the hub — so moving execution later is a dispatch change, not a migration.
   - The prep semaphore and runner concurrency are per-executor, not global.
   - Trigger: move to agent execution when the hub's concurrent-run ceiling (CPU/RAM per WDIO worker) or the hub→agent:4723 network path becomes the bottleneck. Agent execution then reuses the existing pull model (`pendingRuns` on the heartbeat), with its own git/npm cache per agent.
4. **Order → fix the model first, then add.** Phases as in §8; each live-verified on real hardware before the next starts.

## 8. Order

1. **Model & config** — project/platform/variant model, YAML split, picker fix, runner env contract. (Everything else depends on this.) Breakdown:
   1. Config schema: single `app:` block (`id, displayName, platforms[], variants[]?, automation{repoUrl, runner, framework, configPath, testDir, env}`); remove `projects:` map, project-level `platform`, `appium:` from app config, `envFile`.
   2. Org file keeps platform concerns (features, build provider, retention, devices, streaming); per-host Appium wiring moves to agent env.
   3. Trigger input + run model: drop `project` as a choice (stamped from config), add `platform`, `variant?`, `tag?`, `executor` (hub by default).
   4. `/execution/projects` picker removed; frontend trigger form gets platform (+ variant when declared); build/device lists filter by the run's platform.
   5. Runner env contract (§4.3) injected on every run.
   6. Data migration: existing runs/builds keep their stored `project` string for history; analytics groups by the configured app.
   7. Live check: trigger a real Android run from the new form against the real emulator.
2. **Execution correctness** — hub claim stamp, errorClass, stage model + app preflight, worktree, late-writer guard.
3. **Execution visibility** — runner status tree, rerun-failed, combined report.
4. **Device interaction** — remote control + device ops + device state jobs.
5. **Fleet & ops** — agent tombstone/liveness fail-fast, scheduler, notifications, activity log.

Each phase ends with a live run on real hardware before it is called done.
