# Slim virtual devices: feasibility for Mobile Hub

Status: analysis and plan, 2026-11-28. Nothing here is built yet. Input: an external write-up of two open-source "slimming" tools, one for iOS Simulators ([simslim](https://github.com/MobAI-App/simslim), reviewed directly in §3a) and one for Android Virtual Devices (AVDs; "the Android tool" below).

## 0. At a glance

**Verdict.** Take the ideas, use our own code on Android, and keep the iOS tool optional.

- **Android:** build our own opt-in, emulator-only slim profile over `adb`, recorded on every run. Do not add the Android tool.
- **iOS:** when Mobile Hub supports iOS simulators, use [simslim](https://github.com/MobAI-App/simslim) as an **optional, admin-installed** tool that the agent detects and pins by version. Never bundle it or download it automatically. Do not reimplement it: that would mean tracking the same undocumented simulator internals ourselves.
- **Release decisions:** never on slim devices. Use stock virtual devices and physical devices.

| | |
|---|---|
| **Advantages** | 3–5 times more virtual devices per machine (iOS measured by its author: about 4.0 GB down to 0.9 GB, and 258 down to 70 processes); near-zero idle CPU; faster inner loop and cheaper CI runners; can be undone; changes stay inside the virtual device, and the host is not modified. |
| **Disadvantages** | Features silently stop working (push, StoreKit/in-app purchase, universal links, App Clips, MDM, Spotlight, some pickers on iOS; sync, location and Bluetooth on Android). Memory behaviour no longer matches a real device. Triage gets harder. Upkeep is needed on every OS and Xcode release. Savings on our Android setup are probably smaller, because we already cap the guest at 2 GB. |
| **Risks** | A slim-only failure is misread as an app bug. A disable silently does nothing, or hangs boot. A shared or physical device is changed by mistake. A tool breaks on an OS update. Supply-chain risk from third-party code. `disk-clean` deletes data permanently. |
| **Mitigations** | Stamp the profile on every run; `stock` is the default; read back every change; emulator and simulator only; device lock; roll back on a failed boot check; tiered testing; never use slim devices for release. |

## 1. What the analysis proposes (summary)

Stock simulators and emulators run many background services (assistants, indexing, media analysis, cloud sync, store updates). On a laptop these cost gigabytes of RAM and constant CPU, so only 2–3 virtual devices fit next to an IDE. The two tools strip that down:

- **iOS tool (macOS only):** turns off non-essential `launchd` daemons inside the simulator runtime (16 categories). It also clones simulators, plans and cleans disk use, and measures the result. Overrides only persist on recent runtimes (iOS 18.5 and later). It ships as a CLI, a desktop GUI, a Go library and a CI action.
- **Android tool:**
  - QEMU flags: `-lowram` with 1–1.5 GB guest RAM, and `-gpu host`.
  - Disables about 45 packages over `adb` and tightens settings (background process limit, sync, location).
  - `bake` builds a clean "golden" snapshot that restores in about 1.5 s and is never re-saved.
  - `install-shim` wraps the SDK `emulator` binary so IDE launches pick up the slim profile.
  - A CI action.
- **Claimed savings (theirs, not verified here):** iOS about 4.0 GB down to 0.9 GB per simulator; Android about 8.5 GB down to 1.5–2.5 GB, with idle CPU near zero. Both are reversible (`off`, with `--keep`/`--except` lists).
- **Risks they list:**
  - silent feature breakage: push, universal/deep links, in-app purchase, sync, location, Bluetooth;
  - distorted memory behaviour (low-RAM Android raises false out-of-memory errors; freed host RAM hides real leaks);
  - harder triage;
  - fragility across OS releases (daemon and package names change);
  - no substitute for real hardware.
- **Their recommendation:** a three-tier strategy. Tier 1 is slim devices for the inner loop, Tier 2 is stock virtual devices before merge, Tier 3 is physical devices for release.

## 2. Fit with Mobile Hub today

| Area | Mobile Hub today | Fit |
|---|---|---|
| Who launches emulators | Only the dev script (`scripts/start.mjs`). The agent **discovers** devices (`agent/sources/adb-discovery.ts`) and never starts, stops or snapshots one. | Launch flags and snapshots need an emulator lifecycle the agent does not have. |
| Emulator flags | Dev script already caps the guest at `-memory 2048 -cores 2`, `-no-snapshot`, `-no-boot-anim`, `-no-audio`, `-gpu swiftshader_indirect` (host GPU crashed on a hybrid-GPU laptop, see the comment there). | A large part of the RAM saving is already taken; the claimed 8.5 GB baseline does not apply to our setup. `-gpu host` contradicts a recorded lesson and must stay opt-in. |
| adb actions on a device | Remote control as durable device jobs (`modules/device-jobs`, `agent/device-actions.ts`): keys, tap/swipe, text, rotate with read-back, reboot. | Package disable/enable and `settings put` are the same shape: an agent-run adb job with read-back. |
| Device-config jobs | Planned in Phase 4 (permissions, env flags, refuse production), with lessons on read-back (`pm grant` exit 0 but no effect), prefix matching in `pm list packages`, and "skipped, not failed". | A slim profile is a device-config job. The same lessons apply word for word (`pm disable-user` can also no-op). |
| One busy lock per phone | Device jobs require the requester to hold the device lock and refuse during runs and installs. | Applying or removing a profile must take the same lock. |
| iOS | Not supported by the agent (`iosSupport: false`); only streaming has simulator limits. | Nothing to attach the iOS tool's ideas to yet. |
| Host metrics | Phase 5: heartbeat metrics (CPU sampled twice). | "measure/doctor" style before/after numbers belong here. |
| Run evidence | Runs persist raw results, failure evidence and executor. | Recording the active profile and disabled-package manifest on each run fits directly. That is the analysis's own main mitigation. |

## 3. Verdict per idea

| # | Idea | Verdict | Why |
|---|---|---|---|
| 1 | Adopt either tool as a dependency, or call its CLI from the agent | **No** | It is third-party code that edits OS internals, with fast-changing behaviour tied to OS releases, and the binaries are not built from the Node toolchain. Every adopter would inherit its release cadence and supply-chain risk. What we want is about 300 lines of adb calls we already know how to make and test. |
| 2 | `install-shim` (wrap the SDK `emulator` binary) | **No** | It modifies a host's SDK install, breaks silently on SDK update, and surprises anyone sharing the host. Mobile Hub must never edit tools it does not own. |
| 3 | Android package de-bloat as an opt-in **slim profile** device-config job | **Feasible with changes** | Use `pm disable-user --user 0` / `pm enable`, read back with `pm list packages -d` (exact line match), a `keep` list, and a result per package (`disabled` / `skipped` / `failed`). **Emulators only by default**: disabling packages on a physical phone that people share is destructive. The list is ours, kept in config so organisations can edit it, and versioned per API level. |
| 4 | Android settings tweaks (animations off, sync off, location off, background process limit) | **Feasible with changes** | Animations off is already common practice for UI tests and is safe. Sync, location and the background process limit change app behaviour, so they are separate opt-ins that are shown on the run. |
| 5 | `-lowram` with 1–1.5 GB guest RAM | **Not now (opt-in only, later)** | Produces false out-of-memory failures (the analysis says so itself). Only useful for low-end device testing on purpose; never a default. |
| 6 | `-gpu host` | **Not now** | Our own lesson: the host GPU path crashed the emulator. It could become a per-host opt-in config value once a host reports that it works. |
| 7 | Golden snapshot (`bake`), restored per run without saving | **Not now; future "managed emulators" module** | Needs the agent to own emulator start, stop and snapshot, which is a new capability. The payoff is real: a clean state per run, and fast restore instead of our cold boot of about 30 s. Snapshot integrity needs care (a half-written snapshot crashed the next boot; that is why the dev script uses `-no-snapshot`). |
| 8 | iOS daemon pruning | **Not now** | No iOS support in the agent yet. It is macOS-only, needs runtime 18.5 or later, and depends on undocumented daemon names. Revisit after iOS discovery and simulator lifecycle exist. |
| 9 | Simulator cloning | **Not now** | Same dependency on iOS support. |
| 10 | Tiered testing (slim / stock / physical) | **Feasible** | A device `profile` attribute (`stock`, `slim`, plus `physical` implied by the connection type). Device selection can then filter on it, and analytics can separate pass rates by tier, so slim-only failures do not pollute release numbers. |
| 11 | Record the active profile and disabled-package manifest with every run | **Feasible, do first with 3** | Without it, a slim-only failure looks like an app regression, and triage gets harder (the analysis's own drawback 3). |
| 12 | measure / doctor (before and after RAM and CPU) | **Feasible, in Phase 5** | Fold into heartbeat metrics. The guest's own memory comes from `dumpsys meminfo`, and the host process RSS comes from the agent. This lets us verify savings on our setup instead of trusting the analysis's numbers. |

**Top line:** take the ideas, not the Android tool. An opt-in, emulator-only, reversible Android slim profile is a natural device-config job and costs little. Snapshots and iOS wait for capabilities Mobile Hub does not have yet. For iOS, simslim itself is the right tool to integrate later, as an optional one (§3a). That replaces this table's row 8, which assumed we would reimplement it.

## 3a. simslim (the iOS tool), reviewed directly

Source: https://github.com/MobAI-App/simslim. Read on 2026-11-28 from its README, `go.mod` and commit list. Its claims have not been tested here: we have no Mac in the lab.

| Fact | Detail |
|---|---|
| What it does | Writes persistent `launchctl disable` entries into **each simulator's own** launchd database, then reboots that simulator. The Mac itself is not modified, and no sudo is mentioned. Commands go through `xcrun simctl`. |
| Platforms | macOS only. Simulators for iOS, tvOS, watchOS and visionOS. Persistent overrides need iOS/tvOS 18.5+, watchOS 11.5+ or visionOS 2.5+. On iOS 17.x and 18.3 the change lasts only until the next reboot. |
| Modes | `on` / `off <udid>` (restore stock); `enable` / `disable` per category or daemon; `--no-reboot` (live, does not persist on older runtimes); `watch` (slims newly booted simulators, including `xcodebuild` parallel-testing clones); `disk-clean --confirm` (**permanent** deletion of allow-listed caches and logs). |
| Kept running | Core services, and the few whose removal wedges a simulator. |
| Stops working when slimmed (its own list) | Spotlight and Settings search, Files Recents, push (`apsd`), StoreKit testing (`storekitd`), universal links (`swcd`), MDM, App Clips, VoiceOver voice downloads, some Contacts, Photos and Calendar pickers. |
| Claimed savings | Per iOS simulator: 258 → 70 processes, 4.0 GB → 0.9 GB. Measured by the author on one 16 GB M1 Pro, as iOS 26.5 clean-boot medians. 12 slim simulators ran at once, against stock simulators "thrashing at around 5". Other platforms not measured. |
| Install | `brew install mobai-app/tap/simslim` (a third-party tap), or `go install …@latest` (not pinned). There is also a SwiftUI macOS app that you build locally. |
| Dependencies | The README says the Go **library** has no external dependencies. The module as a whole (the CLI and terminal UI) requires 4 direct and 16 indirect Go modules (`urfave/cli`, `charmbracelet/bubbletea` and `lipgloss`, `mattn/go-isatty`, plus `golang.org/x/sys` and `x/text`). |
| Licence | MIT. |
| Maturity | About 4.4k stars, 178 forks, 3 open issues, 4 open PRs, 53 commits. Commits run from 2026-07-24 to 2026-11-17, about 4 months old, and many are AI co-authored. Popular and active, but young. Popularity is not the same as review. |

**Advantages**
- Leaves the host alone. It changes only per-simulator state, which `off`, erase or delete fully undoes.
- It is the only practical way to fit many iOS simulators on one Mac. Apple offers no supported equivalent.
- MIT-licensed and written in Go, so it can be built from a pinned commit and run as a single binary.
- Scriptable, and handles `xcodebuild` parallel clones, which is what CI needs.
- Its documentation states honestly what breaks.

**Disadvantages**
- It depends on an undocumented store format and daemon names. Any Xcode or runtime update can break it, and it lags behind OS releases.
- On older runtimes (iOS 17, 18.3) it has to be re-applied after every boot.
- It breaks several features apps commonly test (push, StoreKit, universal links, App Clips).
- macOS only. Its savings beyond iOS are unmeasured.

**Risks**
- **`watch` mode affects every simulator on the Mac**, including ones the lab does not own. In a shared lab it must not run unscoped.
- **`disk-clean` deletes data permanently.** It must never be exposed as a lab action without a confirmation and an allow-list.
- **Supply chain:** a young project; installs from a third-party tap or an unpinned `@latest`; 20 transitive Go modules for the CLI.
- **Results drift:** an iOS test that passes on a slim simulator can fail on stock, or the reverse.

**Verdict for Mobile Hub**
- **Not now:** the agent has no iOS support.
- **When iOS arrives,** integrate it as an optional external tool:
  - the agent detects `simslim` on PATH and reports its version as a host capability;
  - an admin turns it on per host;
  - only `on` / `off` for simulators the lab owns, and only under the device lock;
  - never `watch` or `disk-clean`;
  - the profile and the simslim version are stamped on every run.
- **No bundling, no automatic download, no reimplementation.** If the tool is missing or the runtime is too old, the simulator just runs stock and the run shows that.

## 4. Dependency inventory and removal plan

### 4.1 What the analysis's approach would add

| Item | Kind | Plan |
|---|---|---|
| simslim CLI, GUI app and Go library | Third-party, MIT, Go (CLI: 4 direct and 16 indirect modules) | **Do not add as a dependency.** Once iOS support exists, detect it as an optional admin-installed tool, pinned by version (§3a). Never bundle or download it. |
| Android tool CLI | Third-party | **Do not add.** Reimplement with `adb`, which is already required. |
| Two third-party CI actions | CI steps fetched from a source-code host at run time | **Do not add.** |
| SDK binary shim | Modifies the host | **Never.** |

simslim is MIT. The Android tool's licence has not been checked; check it before reusing its curated package list verbatim.

### 4.2 Existing non-registry dependencies in Mobile Hub

Six packages come straight from a public source-code host as git dependencies:

- in the root and the backend: `fastify-auth-kit`, `layered-config-ts`, `mongoose-index-guard`;
- in the frontend: `react-design-kit`, `ts-format-utils`, `use-resilient-websocket`.

They are the project's own extracted packages. All are MIT, version 0.1.x, and pinned to a commit in `package-lock.json`.

What that costs today:

- **No integrity hash.** Git entries in the lockfile have no `integrity` field, so `npm ci` cannot verify the bytes it gets. It trusts the host to serve the pinned commit.
- **An SSH/HTTPS rewrite is needed.** The lockfile records `git+ssh://…`. CI works only because every job runs `git config url."https://…".insteadOf "ssh://…"`. A contributor without SSH keys, or a network that blocks git, fails at install.
- **No offline or mirrored install.** Registry mirrors do not proxy git dependencies.
- **Two repos per change.** Fixing one of these packages means a commit there, then a lockfile bump here.

Options for each package:

| Option | Removes the git dependency | Effort | Trade-off |
|---|---|---|---|
| A. Publish to the public npm registry (scoped name, provenance on) | Yes | Small: about half a day for all six, including a publish workflow | Keeps the packages reusable; adds a release step. |
| B. Bring them back in as npm workspaces (`packages/*`) in this repo | Yes | Small to medium: 1–2 days, including moving their tests and CI | One repo, atomic changes, no network fetch. Reverses the earlier extraction, so it needs your decision. |
| C. Keep git dependencies, switch to `https` URLs and commit SHAs | No | Tiny | Removes the rewrite hack only. Still no integrity and no mirror. |

**Recommendation:** A, if the packages are meant for other people (that was the reason for extracting them); B otherwise. Either way, CI drops the `insteadOf` rewrite.

### 4.3 Other dependencies worth a look (optional, not required by this work)

| Dependency | Why look | Replacement | Effort | Risk |
|---|---|---|---|---|
| `argon2` (native addon with an install script) | Native build or prebuilt binary at install | Node's built-in `crypto.scrypt` | Medium: hashes must migrate on next login | Medium (auth); keep unless native builds are a real problem |
| `sharp` (native, platform binary packages) | Large native dependency | None in Node core for JPEG decoding | n/a | Keep; it comes from the registry, so mirrors handle it |
| `dotenv` | Small | `process.loadEnvFile()` (Node 20.12 and later) | Small | Low |
| `axios` (frontend) | One HTTP client | `fetch` plus a 30-line wrapper for the error shape | Small to medium | Low; touches every API hook |
| `concurrently` (root) | Dev-only | `scripts/start.mjs` already orchestrates | Small | Low |

Runtime non-npm dependencies, unchanged by this plan:

- Android SDK (`adb`, `emulator`)
- MongoDB
- container images (`mongo:7`, `node:22`)
- Appium and its drivers

## 5. Risks

1. **Silent breakage reads as an app bug.** Mitigation: stamp the profile on every run and show it on the run page, and keep `stock` as the default.
2. **Package names drift across API levels.** A disable that silently no-ops, or a disabled package that hangs boot, which the analysis reports for one Bluetooth package on Android 16. Mitigation:
   - read back every change;
   - keep a per-API-level list;
   - boot-check after applying and roll back automatically if `sys.boot_completed` does not return.
3. **Applying to a physical device by mistake.** Mitigation: refuse unless the connection type is `emulator`, unless the organisation enables physical devices in config on purpose.
4. **A shared device changed under someone.** Mitigation: the same device lock as runs and device jobs.
5. **Expected savings may be small here.** We already cap the guest at 2 GB. Mitigation: measure first (task P0 below) and drop the work if the gain is marginal.

## 6. Phased plan

| Phase | Task | Maps to | Done when |
|---|---|---|---|
| P0 | Measure the dev emulator now: guest `dumpsys meminfo` totals, emulator process RSS, idle CPU over 60 s. Then measure again after disabling the candidate list by hand. | Phase 5 heartbeat metrics | Numbers recorded in `docs/`. Go or no-go on P1. |
| P1 | `slim` profile as a device-config job: `profiles.android.slim` in org config (packages, keep, settings); agent `applyProfile` / `removeProfile` with read-back; per-item results; emulator-only guard; device lock; boot check with automatic rollback | Phase 4 device-config jobs | Mongo-backed tests; mutation checks; live apply and revert on the dev emulator with exact `pm list packages -d` read-back |
| P1 | `Device.profile` (`stock` or `slim`, plus the list applied); stamped onto each run; shown on device and run pages | Phase 4 | A run started on a slim device shows it; reverting sets `stock` |
| P2 | Device selection and analytics split by profile (tiered strategy) | Phase 5 fleet view / analytics | Pass rate shown per tier |
| P2 | Dependency cleanup: option A or B for the six git packages; drop the CI rewrite | Ops | `npm ci` works with no git or SSH access; lockfile has integrity hashes for all six |
| P3 | Managed emulators on the agent: start, stop, golden snapshot, restore per run without saving, snapshot integrity check | New Phase 6 | Run starts from the snapshot in seconds; a corrupt snapshot falls back to cold boot |
| P3 | Opt-in launch flags per host (`-lowram`, `-gpu host`) once managed emulators exist | Phase 6 | Flags are per-host config and shown on the run |
| Later | iOS: simulator discovery, then lifecycle; then optional simslim integration (detect, pin version, `on`/`off` only, never `watch`/`disk-clean`) | After iOS support | Same read-back, lock and run-stamping rules; a missing or too-old tool means stock, shown on the run |

## 7. Open questions for you

1. Go ahead with P0 (measure) before any code?
2. The six git packages: publish to the registry (A), fold back into this repo (B), or leave them (C)?
3. Should a slim profile ever be allowed on physical devices (organisation opt-in), or should it stay emulator-only for good?
4. Is managed emulator lifecycle (P3) in scope for Mobile Hub at all? It is a real capability jump (the agent starts processes, not just discovers them).
5. For iOS later: integrate simslim as an optional tool (recommended), or never support slim simulators?
