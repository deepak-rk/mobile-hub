# Source Feature Traceability

Every capability the reference platform ("the old farm") had, or that mobile-hub's own `docs/modules/*.md` specified, with exactly one disposition. Created 2026-08-29.

**Why this exists.** Three separate external reviews and several sessions kept rediscovering the same missing features, because the rewrite deliberately avoided the reference implementation's *mechanisms* and — without meaning to — dropped the *jobs* along with them. `docs/TODO.md` answers "does it work?". `docs/modules/*.md` answers "what did we design?". Neither answers "did we consciously decide not to carry this forward?" That question is this file's only job.

**Governing rule:** *preserve the job, replace the flawed mechanism.* "Not copied" without a recorded disposition is requirement drift, not a decision.

## Dispositions

| Status | Meaning |
|---|---|
| **DONE** | Built and verified. |
| **REIMPLEMENT** | Real job, not built. Should exist. |
| **ADAPT** | Real job; the reference's mechanism is wrong for us. Take the job, not the code. |
| **DROP** | Deliberately not carried forward, with a reason. Not a gap. |
| **BLOCKED** | Needs hardware or an upstream capability first. |

## How verified

Everything below marked ✅ was checked against the working tree on 2026-08-29 (grep/read of the actual source), not inferred from trackers. This matters: the three external reviews all state they could not read the repository, and **two of them were wrong about analytics** as a result — see "Corrections" below. Where a claim rests on the tracker rather than code, it says so.

**Re-verified 2026-09-05**: 8 rows in this file had themselves gone stale the same way the external reviews once did — describing work as missing that had actually shipped, mostly on 2026-08-30 (bundled into an unrelated-sounding commit whose message named neither fix) and 2026-09-01/02 (after this file's last full pass). Each corrected row below says so explicitly rather than being silently rewritten, per this file's own governing rule.

---

## Corrections to the external reviews

Recorded so these are not re-imported as gaps next session.

| Review claim | Reality | Evidence |
|---|---|---|
| "Flakiness is hardcoded `0`" | **False.** Real implementation: stddev of daily pass rate over a trailing window, with documented handling for short history and the current partial day. | `analytics.service.ts#computeFlakinessBySuite`; commit `688ccb4` |
| "Frontend cannot select the weekly window" | **False.** `AnalyticsFilterBar` takes and renders a `window` control. | `AnalyticsFilterBar.tsx:23,30,48`; commit `3d2e601` |
| Windows `spawn`, stuck stage, historical logs, workspace cleanup, durable artifacts, install-in-progress, pass-rate semantics, `InstallJob` deprecation, `streaming.md`/`analytics.md` headers | **All done 2026-08-29**, after the reviews' snapshot. | See `TODO.md` § "P0 correctness round" |
| "135 backend tests" | 158 backend, 41 frontend as of 2026-08-29; **249 backend as of 2026-09-05** (grew across the 09-01/09-02/09-05 rounds). | `npm test` |

The reviews were *right* about everything I could verify that wasn't stale — including four items they honestly flagged VERIFY. Their method was sound; their snapshot was old.

---

## 1. Builds & artifacts

| Capability | Disposition | Verified state |
|---|---|---|
| Fetch artifact from a provider | **DONE** | ✅ `url` provider, incl. `file://` |
| Integrity gate before `ready` (size + sha256) | **DONE** — better than reference, whose zip check can pass a truncated artifact | ✅ `builds.service.ts` |
| Retention / GC | **DONE** | ✅ config-driven, never purges a referenced build |
| Serve artifact bytes to the agent | **DONE** | ✅ `GET /api/builds/:id/artifact` |
| Catalog UI: project → versions → detail | **DONE** | ✅ |
| **Download % (provider → hub)** | **REIMPLEMENT — blocked on a contract decision** | ✅ **Still missing, and larger than it looks.** `POST /api/builds` currently **awaits the entire download** before responding, so a 700 MB fetch blocks one HTTP request and there is no window in which a client could observe progress — it cannot even learn the build id until the transfer is finished. Emitting progress therefore requires backgrounding the fetch (create → return `201 {status:'downloading'}` → fetch in the background → push progress), which is what `builds.md` always described and what `execution` already does. **That changes a public contract**: the sibling E2E suite asserts `POST /api/builds` returns `status: 'ready'` synchronously (`playwright-project_js/tests/api/builds.spec.ts:41`). Needs an explicit go-ahead plus a coordinated change in that repo. Do **not** revive the dead `InstallJob` for this — put `downloadedBytes` on `Build`. |
| ~~**Concurrent-fetch guard**~~ | **DONE** — row was stale | ✅ **Fixed 2026-08-30** (`51ace05`, bundled into an unrelated-sounding "usability round" commit — why this row and several others below went stale). `claimBuildFetch()`: an atomic upsert against a partial unique index (`one_inflight_fetch_per_version`), ownership decided by a pre-generated `_id` surviving the upsert, the losing racer's E11000 resolved to the winner's row instead of surfaced. Real, well-engineered, not a stub. Re-confirmed 2026-09-05. |
| **`BuildProvider.listBuilds()`** | **REIMPLEMENT** | ✅ **Missing.** Interface is `fetch()` only, so builds exist only if someone POSTs one. Blocks "browse what CI produced". Add paging + provider-neutral metadata, not an unbounded array. |
| **Build provenance** (build number, branch, commit SHA, commit/PR title, source timestamp, source URL) | **REIMPLEMENT** | ✅ **Zero provenance fields on the model.** Not decoration — it answers "what code produced this binary?" during a regression. Keep provider-neutral. |
| Changelog (commit range between builds) | **ADAPT** | Needs provenance first. If built, take the reference's own safeguards: check SHA reachability, bound the range, time out, never cache an empty result permanently. |
| Contributors | **ADAPT** | Downstream of changelog. Generic contributor refs only. |
| Squad/team breakdown | **DROP** for v1 | Organisation-specific grouping; revisit only via config/provider metadata. |
| App icons on cards | **DROP** for v1 | Requires a config-driven icon map. No hardcoded org tables. |
| "Downloaded" vs "all builds" view | **REIMPLEMENT** (small) | `status === 'ready'` + `artifactPath` already distinguishes these; just not surfaced. |
| ~~Manual "remove local copy"~~ | **DONE** — row was stale | ✅ `POST /:id/purge` + `POST /:id/refetch`, wired end to end: `usePurgeBuild`/`useRefetchBuild` in `frontend/src/features/builds/api/builds.api.ts`, real buttons in `BuildDetailDialog.tsx`. Confirmed 2026-09-05. |
| Associated build artifacts (symbols, metadata bundles) | **DROP** — recorded | No concrete use case yet. Recorded so it isn't "rediscovered". |
| Filename → version/build/SHA regex | **DROP** | Org-specific. Provider's job if anyone's. |
| Nexus TLS bypass | **DROP** | Reference disabled verification silently. Never. |
| Nexus / S3 / webhook providers | **REIMPLEMENT** | Fail-closed stubs today, which is honest. |

## 2. Device install

| Capability | Disposition | Verified state |
|---|---|---|
| Install a ready build onto N devices | **DONE** | ✅ `InstallRun`, agent-polled, `adb install -r`, live-verified on a real emulator |
| Per-device independent status/errors | **DONE** | ✅ embedded `targets[]` |
| Install takes no device lock | **DROP** (deliberate) | ✅ Recorded decision. Compensated by `activeInstall` on the device card. |
| Install-in-progress visible on the device | **DONE** | ✅ `activeInstall` derived per request + badge |
| **Real byte progress (hub → agent)** | **DONE** 2026-08-30 | ✅ `downloadArtifact` counts bytes through a `Transform` and reports `downloaded/total` throttled to ~1s (the cadence `builds.md` specifies). Reports are fire-and-forget so a dropped update can't fail a healthy install. Live-verified: a real install now reports an intermediate value where it previously went 0→100. 3 unit tests pin cumulative-and-monotonic counting and the null-total case. |
| Determinate % during `adb install` | **DROP** (implemented as a phase label) | ✅ `adb install` exposes no byte ratio, so progress deliberately stops moving and the phase carries the meaning. The UI shows "Installing on device…" instead of a bar frozen at 100% pretending to work. Fabricating a rising number here would be the same lie the byte counting removes. |
| Honest bar semantics in the UI | **DONE** 2026-08-30 | ✅ A determinate bar renders only while real byte progress is moving; "Starting download…" before the first sample; phase label during install. |
| **Platform compatibility validation** | **DONE** 2026-08-30 (platform axis) | ✅ `triggerInstallRun` now rejects a target whose `device.platform` differs from `build.platform` with `400 INCOMPATIBLE_DEVICE`. Validation happens before any `InstallRun` is created, so a mixed batch fails atomically rather than half-starting. Live-verified against a real iOS device record: clear message, no partial run. Server-side deliberately duplicates the frontend's platform-filtered picker — a filtered picker is a convenience, never a guarantee. **Still to model:** finer axes (`artifactKind` IPA-vs-simulator-app, `supportedConnectionTypes`, min OS version) — the platform axis is the one that was actually reachable. |
| Post-install verification (package present at expected version) | **REIMPLEMENT** (small) | Reference had none; don't inherit that. Cheap with `adb shell pm list packages`. |
| Automatic rollback | **DROP** for now | Reference lists "no rollback" as a known limitation. Verification first; rollback is a separate product decision with real complexity and no current demand. |
| **Uninstall** | **REIMPLEMENT** | ✅ **Missing entirely.** Model as a device-app operation (requestedBy, device, package, timing, status), not a one-off UI call. |
| ~~"Installed on N devices" / "installed 1d ago"~~ | **DONE 2026-09-05** | ✅ `getInstalledDevicesForBuild()` now enriches with `deviceName` (batch-looked-up, not N+1); `BuildDetailDialog` shows "Installed on N device(s)" with each device name (linking to its page) and a relative "installed Xd ago" — live-verified in a real browser against real seeded data (a real APK installed on `emulator-5554`), zero console errors. |
| Post-install GUI env setup via hardcoded taps | **DROP** | The reference's worst idea — brittle against any app UI change. `automation.env` replaces the *job*. |

## 3. Execution

| Capability | Disposition | Verified state |
|---|---|---|
| Stage machine, atomic lock, guaranteed release, cancel, orphan recovery | **DONE** | ✅ |
| Real `git clone` + `node_modules` cache when `automation.repoUrl` set | **DONE** | ✅ verified against the real sibling repo |
| Cross-platform process supervision (Windows `.cmd`, tree-kill, timeouts, outcomes) | **DONE** | ✅ `common/process-supervisor.ts`, 13 tests |
| Durable artifacts split from ephemeral workspace | **DONE** | ✅ |
| Historical run logs served | **DONE** | ✅ `GET /api/execution/:id/logs` + UI fallback |
| Result taxonomy (`test` / `infra` / `precondition`) | **DONE** | ✅ pass rate now excludes non-attributable runs |
| ~~**Cache key = package.json + lockfile + platform + Node**~~ | **DONE** — row was stale | ✅ **Fixed 2026-08-30** (`51ace05`, same bundled commit as the concurrent-fetch guard above). `computeCacheKey()` hashes package.json + every present lockfile (name and contents) + platform + Node version. Had zero unit tests until 2026-09-05 despite its own doc comment saying "exported for testing" — 6 added, all pass. |
| Cache restore via symlink | **ADAPT → DROP** | Recursive copy is the right Windows default (dir symlinks need admin/Dev Mode). Recorded as a deliberate deviation. |
| ~~**Allure: collect / generate / serve**~~ | **DONE** — row was stale | ✅ Collect+serve built: `collectAllureReport()` copies a runner-produced `allure-report/index.html` to durable `artifactsPath` (checked before workspace cleanup, runs on every terminal path including failures), `reportPath` set, `GET /:id/report` + `/:id/report/*` serve it with a path-traversal guard, UI hides the link when null. "Generate" was never built (nothing runs `allure generate`) but is now moot: `testSummary` (below) extracts the same data directly from raw `allure-results`, which is why a WDIO run that never calls `allure generate` still produces real numbers. Confirmed 2026-09-05. |
| **`testSummary` extraction** (total/passed/failed/broken/skipped) | **DONE** 2026-09-02 | ✅ The sharpest finding in the external reviews, and correct. Parsed from the runner's raw `allure-results`, not the generated HTML — the report is a rendering of exactly this data, and it also means the summary works when a runner writes results but never runs `allure generate`, which is the common case here. Retries collapse by `historyId`, or a flaky-but-eventually-passing test would count as both a pass and a failure; pointed at the sibling repo's checked-in results this correctly reduced 18 files from three runs to 6 real tests. Skipped tests stay in the denominator. Null rather than zeros when nothing reported, since "not using Allure" and "ran zero tests" are different facts. **Live-verified**: a real run finished `passed` with `{total: 2, passed: 2, passRate: 1}`. Analytics carries `totalTests`/`passedTests`/`testPassRate` plus `runsWithTestResults`, which is what separates "everything failed" from "nothing reported" — both leave the rate at 0. |
| **`automation.env` injection** | **DONE** 2026-09-01 (injection + containment) | ✅ Values declared in config reach the runner, and the hard half — containment — is what got built. The child does **not** inherit the hub's environment; it gets an allow-list (`run-environment.ts`), because this workspace has already seen a child dump its whole inherited environment into a crash report, so "our code never prints the secret" is not a defence. Redaction matches on **values**, not key names: a secret leaks by being printed, and a stack trace embedding a token never mentions the key it came from. **Still open:** values are inline in YAML. Secret *references* (a keystore/vault lookup) remain the right end state — the injection path is now the easy part of that change. |
| **`automation.install` as a declared step** | **DONE** 2026-09-01 | ✅ Declared in config, defaulting to `npm ci` for known frameworks. The cache tension is now explicit rather than accidental: `npm ci` deletes `node_modules` and so discards a restored cache, which is why a project wanting the cache to count declares `install: npm install`. That tradeoff is the org’s, so it is a config key. |
| **`automation.framework` / `configPath` / `testDir`** | **DONE** 2026-09-01 | ✅ Were inert — only `repoUrl` was read, which is why operators still typed `npm ci` and `npx wdio run …` by hand. `framework` + `configPath` now build both commands (`automation-commands.ts`); `testDir` drives suite discovery. Verified live: a trigger carrying no commands at all cloned, cached, installed and ran. |
| `automation.envFile` | **REIMPLEMENT** | ✅ Still inert, and now the only half of the env story left. `automation.env` shipped 2026-09-01 with the containment design; this key is the remaining question of whether the hub reads a file from the checkout or leaves that to the runner (which loads its own `.env` today). |
| **`SuiteProvider` — real suite discovery** | **DONE** 2026-09-01 | ✅ `SuiteProvider` + `CucumberSuiteProvider` read `.feature` files under the configured `testDir` (statically — never importing the checkout). Offers tags and feature files; shallow checkout cached between calls. Live-verified: three real features discovered from the automation repo with their Gherkin titles, surfaced as a dropdown. **Still open for flakiness**: suite ids are now stable and real, but nothing yet prevents the same logical suite being addressed as both a tag and a feature path. |
| Entity / tag as real run inputs | **REIMPLEMENT** | Downstream of `SuiteProvider`. |
| Searchable branch picker + last-commit metadata | **ADAPT** | `git ls-remote --heads` when `repoUrl` is set. No vendor Graph API. |
| **Appium orchestration** | **DONE** 2026-09-01 | ✅ The boundary between "command runner with device locking" and "mobile test farm" is crossed. Servers are per **device**, not per run — a run starting its own pays startup every time, and two runs on different devices fight over a port. Ports are assigned once from a configured base and **persisted on the device** via a conditional write, keeping `appium-server-setup`'s property (a port written down cannot leak or race) for devices the hub discovers rather than a human enumerating. An already-listening server is adopted, not replaced. Driver presence is checked up front, because a missing UiAutomator2 driver previously surfaced two minutes in, after a clone and a full install. **Live-verified: 7 Gherkin steps passing on `emulator-5554` from a trigger naming only a project, a suite and a device.** |
| **Real queue + backoff when the device is busy** | **ADAPT or rename** | ✅ `'queued'` is set once at creation and never revisited — there is no queue. A busy device returns 409 and marks the run failed. Either build the queue or stop using the word on the trigger form. |
| Snapshot run metadata (platform, model, framework, suite, branch, commit) | **DONE** 2026-09-02 | ✅ `ExecutionRun.snapshot`, frozen at trigger time, plus the commit resolved after `pulling` — branch alone never identified what ran, since a branch moves. Analytics reads the snapshot and keeps the live join only for runs predating it; back-filling those would be a guess dressed as a fact. Live-verified: a real run recorded `platform: android`, `deviceName: Pixel 3a`, `framework: appium`, `suiteKind: feature`, `commit: 9d806f76…`. |
| Re-run with the same configuration | **REIMPLEMENT** (small) | Copy immutable inputs, re-resolve device/branch/secrets. Cheap once inputs are canonical. |
| Server-side / shared presets | **DROP** for v1 | localStorage presets shipped and are enough for one operator. Revisit when the form has canonical fields worth sharing. |
| propChain baton refactor | **DROP** | Recorded accepted deviation. Not worth a rewrite for purity. |
| SSE for logs, WS for stages | **DROP** | Both on WS works. Serving the historical file was the real job and is done. |
| Journey correlation by time overlap | **DROP** | The reference itself calls it ambiguous. Correlate by run id only. |
| Global Appium basePath / shared cache dying on restart | **DROP** | Reference scar. |
| One slow install blocking all runs | **DROP** | Reference scar. |

## 4. Streaming / live view

| Capability | Disposition | Verified state |
|---|---|---|
| One capture per host+device+protocol, N viewers | **DONE** — better than reference, which multiplies H264 per viewer | ✅ |
| Connection banner, `retryKey`, error propagation, auth gating | **DONE** | ✅ |
| Per-host Android capture cap | **DONE** | ✅ (verify the write-path, per the `isSimulator` lesson) |
| Opt-in capture (no auto-connect on page load) | **DONE** (deliberate) | ✅ Keep. |
| **`adb` runs beside the device, on the agent** | **REIMPLEMENT** | ✅ **Largest architecture gap.** `adb-mjpeg.source.ts` / `adb-h264.source.ts` spawn from the **hub backend**; the agent has discovery + installer only. The hub cannot `adb -s <udid>` a device attached to another machine, so live view silently works *only* for devices on the hub's own host — contradicting the multi-host model the rest of the system is built for. |
| **Scaled JPEG over `multipart/x-mixed-replace` into `<img>`** | **REIMPLEMENT** | ✅ Ships full PNG (~0.5 MB/frame) over WebSocket into a blob URL. Most of "it feels slower than the old farm". Compress **on the agent**, before the network hop — compressing centrally just moves the problem. |
| **Tab-visibility pause** | **REIMPLEMENT** | ✅ No `visibilitychange` handling anywhere. The 10-min idle grace covers *zero viewers*, not a backgrounded tab. |
| **Newest-frame-wins backpressure** | **REIMPLEMENT** | ✅ Frames are not dropped for a slow consumer. |
| **`sourceHost` per tile / multi-host wall** | **REIMPLEMENT** | ✅ Absent. Blocked behind capture locality. |
| ~~**"View live" on the device card**~~ | **DONE** — row was stale | ✅ Every online, non-selectable card has an explicit "View live" button (`DevicesPage.tsx`) linking to `/devices/:udid` — navigation only, doesn't auto-start a capture, matching the deliberate page-level gate. Confirmed 2026-09-05. |
| ~~Multi-view mode in the inventory header (cards → checkboxes)~~ | **DONE** — row was stale | ✅ Per-card checkboxes ("Select N for multi-view") feed a header-level "Multi-view" button navigating to `/devices/multi-view?udids=...` — exactly the design this row asked for. Confirmed 2026-09-05. |
| Short linger after last viewer | **ADAPT** | Currently a 10-min zero-viewer grace; reference used ~30s. Tuning, not a missing capability. |
| Dedicated stream port | **DROP** unless measured | Deliberately unified onto the API origin. Re-measure with 3 tiles + API + execution WS before reversing. |
| Per-viewer H264 processes | **DROP** | Reference scar. |
| iOS simulator capture | **BLOCKED** | No Mac. |
| Physical iOS streaming | **BLOCKED** | Reference also parked this. |

## 5. Analytics

| Capability | Disposition | Verified state |
|---|---|---|
| Daily + weekly aggregates, byDevice/bySuite, hourly recompute | **DONE** | ✅ |
| Real flakiness (stddev of daily pass rate) | **DONE** | ✅ **Both external reviews wrongly call this hardcoded `0`.** |
| Weekly window selector in the UI | **DONE** | ✅ **Both external reviews wrongly call this missing.** |
| Pass rate excludes infra/precondition failures | **DONE** | ✅ shipped 2026-08-29 |
| ~~**Test-case-level counts** (total/passed/failed/broken/skipped)~~ | **DONE** — row was stale | ✅ **Done 2026-09-02.** `TestSummary` (`allure-summary.ts`) carries total/passed/failed/broken/skipped/unknown + `passRate`; `ExecutionRun.testSummary` and analytics' `totalTests`/`passedTests`/`testPassRate`/`runsWithTestResults` all shipped and live-verified (see `TODO.md`'s execution module notes). Both run-rate and test-rate exist and are labeled distinctly. Confirmed 2026-09-05. |
| **Failure-reason aggregation** | **ADAPT** | "Recent failures" answers *what failed?*; grouped reasons answer *what fails repeatedly?* Group by a normalized signature (exception type + normalized message + stage), not the raw string — the reference grouped by exact string and fragmented on variable messages. Stage error strings are enough to start. |
| ~~Snapshot platform/device on the run~~ | **DONE** — row was stale | ✅ Same item as in Execution, done 2026-09-02. |
| Branch / entity / suite / tag dimensions | **BLOCKED** | Needs canonical run inputs. Do not draw empty filters. |
| Previous-period KPI deltas | **ADAPT** | Cheap once the aggregate pair is queried. |
| Duration min/max trend | **ADAPT** | Low priority; useful for slow-tail regressions. |
| Journey correlation by time window | **DROP** | Ambiguous by the reference's own admission. |

## 6. Cross-cutting

| Capability | Disposition | Verified state |
|---|---|---|
| Lock TTL + renew, stale-host sweep | **DONE** | ✅ Keep |
| Per-agent revocable credentials | **DONE** | ✅ Keep — better than one shared token |
| Fail-closed stubs everywhere | **DONE** | ✅ Keep |
| Hidden (not disabled) unavailable actions | **DONE** | ✅ Keep |
| Dark-by-default + design tokens | **DONE** | ✅ Keep — do not adopt the reference's light shell |
| Host operational diagnostics (disk, versions, active streams/runs) | **REIMPLEMENT** | Becomes important once the farm is genuinely multi-host. |
| Separate "Infrastructure" nav | **DROP** | Servers→Hosts already covers it. Don't add a second host list. |

---

## Ordered plan

Sequenced by: *lies and safety gaps first, then unblocking chains, then features that need those chains.* Each item names why it is where it is.

### P0 — on-screen falsehoods and safety gaps (small, independent)

1. ~~**Byte progress, hub → agent.**~~ **DONE 2026-08-30.** Real byte counting, ~1s throttle, honest bar semantics. The lie the user actually saw.
2. ~~**Install platform compatibility check.**~~ **DONE 2026-08-30.** `400 INCOMPATIBLE_DEVICE` before any run is created.
3. **Byte progress, provider → hub** — **needs a decision first.** Requires backgrounding `POST /api/builds`, which breaks the sibling E2E's synchronous `status: 'ready'` assertion. See the Builds row above. Still the only genuinely open P0 item.
4. ~~**Concurrent-fetch guard.**~~ **Row corrected 2026-09-05 — was already done 2026-08-30**, same bundled commit as (5) below. Went unmarked because neither fix's commit message mentioned it.
5. ~~**Cache key = package.json + lockfile + platform + Node.**~~ **Row corrected 2026-09-05 — was already done 2026-08-30.** Unit-tested 2026-09-05 (had zero tests despite its own doc comment saying otherwise).

### P1 — operator jobs on pipes that already work (small, high visible value)

5. ~~**"View live" on the device card.**~~ **Row corrected 2026-09-05 — already done.** Every online card has one.
6. ~~**Multi-view mode in the inventory header.**~~ **Row corrected 2026-09-05 — already done.** Checkboxes + header button, feeding the existing route.
7. ~~**Serve Allure when `allure-report/index.html` already exists.**~~ **Row corrected 2026-09-05 — already done**, and superseded in practice by `testSummary` extracting the same data straight from raw results regardless of whether a report was generated.
8. ~~**"Installed on N devices"**~~ **done 2026-09-05.** See the Device install row above. **Post-install verification** (package present at expected version) is the only piece of this item still open.

### P2 — the streaming re-architecture (one project, not two)

9. **Move capture to the agent** (agent owns `adb`/`xcrun`; hub relays and fans out). Keep the shared-capture invariant.
10. **Scaled JPEG + `multipart/x-mixed-replace`**, compressed agent-side, plus **visibility pause** and **drop-oldest-frame**. Naturally the same change as (9); doing it before (9) would build the compression in the wrong process.
11. Then re-benchmark and make the multi-view cap configurable rather than a hardcoded 3.

### P3 — the real product loop (each unblocks the next)

12. ~~**`automation.install`**~~ **done 2026-09-01.** Still open: **secure `automation.env`** — secret references rather than inline ciphertext, an allow-listed child environment, redaction from logs. The supervisor already defaults to no env inheritance, which is the hard half.
13. ~~**`SuiteProvider`**~~ **done 2026-09-01** for Cucumber/WDIO. Still open downstream: **canonical suite identity** (a tag and a feature path can name overlapping sets, so flakiness across them is not yet trustworthy), entity/tag as first-class inputs, and a branch picker via `git ls-remote --heads`.
14. ~~**Appium orchestration**~~ **done 2026-09-01.** Per-device servers, persisted ports, adopt-don't-replace, up-front driver check. This is what makes (15) possible at all — there were no Allure results to extract before a real session existed.
15. ~~**`testSummary` extraction** from Allure results~~ **done 2026-09-02**, including **per-run failure-reason grouping** — distinct reasons with how many tests hit each, since a failed count says how bad but not what. Still open: **aggregating those reasons across runs** ("this message has hit 40 times this week"), which needs a dedup design at the aggregate level rather than more parsing.
16. **`BuildProvider.listBuilds()`** + build provenance → then changelog with the reference's safeguards.
17. ~~Snapshotted run metadata~~ **done 2026-09-02.** Still open: **uninstall** and host diagnostics.

### Blocked — never lead with these

iOS discovery / simulator install / simulator streaming (needs a Mac). H264 browser decode (needs a physical Android device). Physical iOS (reference parked it too).

### Do not build

Hardcoded tap tours, entity maps, icon packs, filename regexes. Appium capabilities on every card. Empty analytics dimensions. Per-viewer H264. A report tab that 404s. Changelog UI before provenance data exists. A rebuild of `/devices/multi-view`.

---

## Maintenance

This file has exactly one failure mode: going stale, which is the disease it was created to cure. Two rules:

- `docs/SELF_REVIEW.md` § 1 requires updating a row here whenever a module with a `docs/modules/*.md` changes.
- A row moves to **DONE** only when verified against running code — the same bar `TODO.md` uses for ✅, for the same reason (three separate "status outran reality" incidents are already recorded in `LESSONS.md`).

---

## Open items found while building the above (2026-09-01)

Recorded when noticed rather than left to be rediscovered.

| Item | Why it matters |
|---|---|
| ~~**Config only loads at boot**~~ | **Closed 2026-09-02.** `POST /api/config/reload` (admin), with the button beside the trigger form's Project dropdown because that is where the absence is felt. The predicted trap was real and larger than expected: `app.config` had to become a getter/setter decorator, because a plain assignment inside the config plugin's encapsulated scope shadowed the parent and left every other route on the boot config; and the build-GC and lock-expiry sweeps were closing over the boot-time local rather than reading `app.config` per tick. See docs/LESSONS.md. Live-verified both directions against the running hub — a project added to the YAML appeared, and removing it again reported it removed. |
| ~~**Analytics' project filter is still free text**~~ | **Closed 2026-09-02.** A dropdown fed by the same `/execution/projects` the trigger form uses. The debounce went with the free text — a selection is discrete, and delaying it only made the chart lag the control. A project named in the URL that the list does not know about is kept as an option rather than snapping to "All projects" and quietly showing different data than the URL claims. |
| ~~**Suite identity is not canonical**~~ | **Closed 2026-09-02.** Suites bucket by kind *and* name, so a tag and a feature path sharing a name are tracked separately — which is correct, since they select different sets of tests, and pooling them was what made a variance measure meaningless. Reported under the bare name, because the UI links a suite row to `/execution?suite=<suite>` and a qualified value would match nothing. The first attempt got the historical fallback wrong and a real aggregate showed it: unqualified runs fell back to a null kind, splitting one feature file into two rows. They now fall back to *classifying* the string — the same pure function the runner used to pick its flag — and the buckets merged, 7 historical plus 2 new into one row of 9. |
| ~~**Appium is still not orchestrated**~~ | **Closed 2026-09-01.** Running it surfaced four defects nothing static would have caught: `--suite` was handed a feature path (WebdriverIO's three selectors — named suite, `--spec`, Cucumber tag expression — are different things, now inferred from shape); artifacts were stored extensionless and Appium refuses an app path without one; `APP_PATH` was plumbed but never populated, so sessions opened against whatever was already on screen; and `ANDROID_HOME` is set on no machine here, so it is now derived from the configured adb path. |
| ~~**`sdk_gphone64_x86_64` on the device detail page**~~ | **Resolved 2026-09-02:** the value stays, the label was the defect. It names a *system image*, not a product model, so calling it "Model" was simply false. The detail page is the diagnostic view and "which system image is this AVD running" is a real question, so hiding it there — as the cards do — would have been the wrong trade. |
