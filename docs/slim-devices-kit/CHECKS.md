# Check catalogue

Evaluate every check whose platform is in scope (Q1). Each one has:

- **Condition:** when it fires;
- **Severity**: `high`, `medium`, `low` or `info`;
- **Fix:** what to recommend;
- **Risk:** of making that change;
- **Phase:** P0–P5.

Adapt each fix to the project's real files and framework syntax. A check that clearly passes goes in the report's "What is already good" list.

Severity meaning:

- **high:** blocks offline use, or costs tens of seconds per session or run;
- **medium:** a measurable slowdown or flake source;
- **low:** a small gain or hygiene;
- **info:** context or a candidate for later phases.

## Dependencies and offline

| ID | Condition | Sev | Fix | Risk | Phase |
|---|---|---|---|---|---|
| DEP-GIT | A dependency spec is a repository URL: `git+…`, `git://`, `github:`, `gitlab:`, `bitbucket:`, `http(s)://…`, or `owner/repo` / `owner/repo#ref` in `package.json`; `git+`/URL lines in `requirements*.txt`; `git:` sources in `Gemfile`; JitPack-style GitHub coordinates in Gradle | high | Publish the package to the internal registry, or vendor it as a tarball with a SHA-256, and depend on a pinned version. | Medium: the mirrored version may differ from what the URL serves today; pin to the commit currently in the lockfile and diff. | P0 |
| NET-GITHUB | A script or CI step fetches from public GitHub at run time: `git clone …github.com`, `curl`/`wget` of `github.com` or `raw.githubusercontent.com`, GitHub release downloads, public marketplace actions (`uses: owner/action@ref`) on a network that cannot reach them, or `appium driver run xcuitest download-wda-sim` (downloads from GitHub releases) | high | Mirror the artifact internally with a checksum. For CI actions use an internally mirrored copy pinned to a full commit SHA. Replace the WDA download with a local `xcodebuild` build (`knowledge/ios.md` §5). | Low | P0 |
| NET-CURLSH | A remote script is piped into a shell (`curl … \| sh`, `bash <(curl …)`) | high | Fetch from the internal mirror to a file, verify its SHA-256, review it, then run it. | Low | P0 |
| DEP-LOCK | Mobile/test dependencies exist but no lockfile is committed | medium | Commit the lockfile. Use `npm ci`, `pip install --require-hashes -r`, or Gradle dependency locking. | Low | P0 |
| DEP-RANGE | Appium, driver or framework versions use open ranges (`^`, `~`, `>=`, `latest`, `*`) and are installed outside the lockfile (global `npm i -g appium`, `appium driver install uiautomator2` with no `@version`) | medium | Pin exact versions in a setup doc or script (`appium@X.Y.Z`, `uiautomator2@X.Y.Z`). Consider a project-local `APPIUM_HOME`. | Low | P0 |
| DEP-DRIVER-SKEW | The same driver is installed globally and project-locally with different versions, or the driver's `peerDependencies.appium` / `engines.node` is not met | medium | Use one location and one pinned version. Upgrade or downgrade Node/Appium to satisfy the driver's declared ranges, read from its local `package.json`. | Low | P0 |
| DEP-NODRIVER-A | Android in scope and no UiAutomator2/Espresso driver installed | medium | `appium driver install uiautomator2@<pinned>` with npm pointed at the internal registry. | Low | P0 |
| DEP-NODRIVER-I | iOS in scope, macOS host, and no XCUITest driver installed | high | `appium driver install xcuitest@<pinned>` from the internal registry. It carries WebDriverAgent source. | Low | P0 |
| TP-SLIM | The project references third-party device-slimming or "debloat" tools or scripts | medium | Treat them as untrusted until reviewed: they change system state. The same results are reachable with vendor tools (`knowledge/risks.md` §3). | High if run unreviewed | P3 |

## Host

| ID | Condition | Sev | Fix | Risk | Phase |
|---|---|---|---|---|---|
| HOST-ACCEL | Android in scope and emulator acceleration unusable | high | Enable virtualisation in firmware. Windows: enable Windows Hypervisor Platform (or the Android Emulator hypervisor driver). Linux: KVM, with the user in group `kvm`. Without it, boots are 5–10× slower. | Low (host admin change) | P1 |
| HOST-ARCH | Apple silicon host using `x86_64` AVD images, or an x86 host using `arm64` images | high | Use images whose ABI matches the host (`arm64-v8a` on Apple silicon). Translated images are far slower. | Low | P2 |
| HOST-CAP | Q4 target exceeds the capacity estimate (below) | high | Lower per-device RAM, use lean images, run headless, or split across hosts. Measure in P0 first. | Low | P4 |
| HOST-DISK | Under 30 GB free | medium | Each AVD with snapshots takes 6–15 GB, each simulator runtime 5–8 GB. Remove unused AVDs and `xcrun simctl delete unavailable`. | Low | P1 |

### Capacity estimate

- **Per Android emulator:** `hw.ramSize` + about 0.7 GB emulator overhead. If unknown, 2.7 GB.
- **Per iOS simulator:** about 1.5 GB (more for heavy apps).
- **Host reserve:** 4 GB for the OS, IDE and Appium.
- **Formula:** `devices = min( floor((RAM − 4 GB) / per_device), floor(logical_CPUs / 2) )`.
- **Label:** in the report, label the result "estimate, confirm in P0". Swap use during a P0 parallel run is the real limit.

## Android

| ID | Condition | Sev | Fix | Risk | Phase |
|---|---|---|---|---|---|
| AND-SDK | No Android SDK found | high | Install from the internal SDK mirror (`knowledge/android.md` §9) and set `ANDROID_HOME`. | Low | P0 |
| AND-IMG-PLAY | An AVD in use has a Play Store image and Q6 does not need Play Services | medium | Use `google_atd`/`aosp_atd` (API 30+), or `google_apis` if Google APIs are needed (`knowledge/android.md` §5). | Medium: behaviour tied to Play differs; confirm Q6 | P2 |
| AND-COLD | `fastboot.forceColdBoot=yes`, or scripts pass `-no-snapshot-load` on every run | medium | Boot from a prepared named snapshot (`knowledge/android.md` §3). | Low | P1 |
| AND-NOSNAP | No Quick Boot or named snapshot on an AVD used by tests | low | Prepare a warm snapshot once. | Low | P1 |
| AND-WIPE | Scripts start emulators with `-wipe-data` | medium | Use a clean, read-only snapshot instead: the same clean state without paying first-boot cost. | Low | P1 |
| AND-ANIM | A running device has any animation scale ≠ 0 and neither `appium:disableWindowAnimation` nor a script sets them | medium | Set them to 0 in the warm snapshot, or use the capability. | Low (only if the app tests animations) | P1 |
| AND-VERIFY | `verifier_verify_adb_installs` ≠ 0 on test devices | low | `settings put global verifier_verify_adb_installs 0` in the snapshot. | Low | P1 |
| AND-U2-WARM | `io.appium.uiautomator2.server*` / `io.appium.settings` not preinstalled on devices used repeatedly | low | Run one session before saving the warm snapshot. Then consider `appium:skipServerInstallation` (`knowledge/capabilities.md`). | Low: must be redone when the driver is upgraded | P1 |
| AND-RAM | `hw.ramSize` > 4 GB | low | 2–3 GB fits most apps. Measure with `dumpsys meminfo <pkg>`. | Low | P4 |
| AND-CAMERA | Cameras emulated or webcam while Q6 excludes camera | low | `hw.camera.back=none`, `hw.camera.front=none`. | Low | P2 |
| AND-PKGS | A device has > 250 enabled packages | info | Candidate for a P3 slim profile (`knowledge/android.md` §7). | Medium | P3 |
| AND-HEADLESS | CI or lab runs show an emulator window (no `-no-window`) | low | `-no-window -no-audio -no-boot-anim`. | Low | P5 |
| CAP-FULLRESET | `fullReset: true` anywhere in active capabilities | medium | `noReset: true` plus explicit state reset (`knowledge/capabilities.md` §Reset). Keep a full reinstall for one nightly job. | Low/Medium: tests that assumed a fresh install must reset explicitly | P1 |
| CAP-PORTS-A | Q4 > 1 and no per-worker `appium:systemPort` (plus `mjpegServerPort`/`chromedriverPort` when used) | medium | Allocate the ports from the worker index. | Low | P4 |
| CAP-AVD-TIMEOUT | Capabilities launch the AVD (`appium:avd`) without `avdLaunchTimeout`/`avdReadyTimeout` | low | Set both (for example 180000 / 180000) and prefer starting the emulator before the session. | Low | P1 |

## iOS and WebDriverAgent

| ID | Condition | Sev | Fix | Risk | Phase |
|---|---|---|---|---|---|
| IOS-HOST | iOS in scope but this host is not macOS | info | Re-run on the macOS host. Capability checks still apply. | — | P0 |
| WDA-NOBUILD | macOS, iOS in scope, and no prebuilt WDA found (§6 of PROBES.md) | high | Build WDA once per Xcode + driver version (`knowledge/ios.md` §5). Each cold session otherwise compiles it for 30–120 s. | Low | P1 |
| WDA-STALE | The prebuilt WDA is older than the installed Xcode, or than the driver's bundled WDA version | medium | Rebuild, and key the build folder on `xcodebuild -version` + WDA version. | Low | P1 |
| CAP-WDA | None of `usePrebuiltWDA`, `prebuiltWDAPath`, `useXctestrunFile`, `webDriverAgentUrl`, `usePreinstalledWDA` is set, and no script prebuilds WDA | high | `appium:usePrebuiltWDA: true` + `appium:derivedDataPath: <fixed dir per simulator>`, or the xctestrun route (`knowledge/ios.md` §5–§6). | Low | P1 |
| CAP-NEWWDA | `useNewWDA: true` | medium | `false`, so a running WDA is reused. Keep `true` only as a recovery step. | Low | P1 |
| CAP-PORTS-I | Q4 > 1 and no per-simulator `wdaLocalPort` (and `mjpegServerPort`), or a shared `derivedDataPath` across parallel simulators | medium | Unique port and derived data folder per simulator. | Low | P4 |
| CAP-WDATIMEOUT | No prebuilt WDA and default `wdaLaunchTimeout` | low | After prebuilding: `wdaLaunchTimeout: 120000`, `wdaStartupRetries: 2`, `wdaStartupRetryInterval: 20000`. | Low | P1 |
| IOS-ERASE | Scripts `simctl erase` or create new simulators each run | low | Clone from a golden simulator (`knowledge/ios.md` §3). | Low | P2 |
| IOS-STALE | Unavailable simulators exist | low | `xcrun simctl delete unavailable` (removes only simulators whose runtime is gone). | Low | P1 |
| IOS-MANY | More than 40 simulators defined | low | One golden simulator per runtime/device type, clones per worker. | Low | P2 |
| IOS-COLDSTART | Every session boots its simulator (no warm pool) and Q7 allows keeping them booted | medium | Boot workers before the run and keep them booted (`knowledge/ios.md` §2). | Low | P1 |
| CAP-QUIESCENCE | `waitForQuiescence` left at the default on an app with continuous animation or polling | low | `waitForQuiescence: false`, or `animationCoolOffTimeout` tuning; also `reduceMotion: true`. | Low/Medium: may expose real timing bugs | P1 |

## CI

| ID | Condition | Sev | Fix | Risk | Phase |
|---|---|---|---|---|---|
| CI-AVDCACHE | CI starts an emulator with no cache of the AVD and snapshot | medium | Cache `~/.android/avd/<name>.avd` and `<name>.ini`, keyed on image + emulator version + config hash. Create the snapshot on a cache miss. | Low | P5 |
| CI-WDA | macOS CI runs iOS tests with no WDA build/cache step | high | `build-for-testing` step for WDA, cached and keyed on Xcode + WDA version. | Low | P5 |
| CI-GPU | CI emulator without an explicit software GPU | low | `-gpu swiftshader_indirect`. | Low | P5 |
| CI-NODEVICE | CI exists but runs no device tests | info | Note that device tests run elsewhere; ask where (Q2). | — | — |

## Phases

| Phase | Goal | Done when |
|---|---|---|
| P0 Baseline and unblock | Measure before changing; remove every need for public network access. | Numbers recorded (`PROBES.md` §7). A clean install works from internal sources only. |
| P1 Zero-risk warm-up | Configuration and warm state only; device images unchanged. | Warm boot and session start lower than P0; zero new failures over 3 full runs. |
| P2 Lean images, golden devices | Leaner vendor images; one golden device per OS version, copied per worker. | Golden device reproducible from mirrored inputs and documented. |
| P3 Slim profiles | Switch off reviewed packages/daemons as an allow-list, verified and reversible. | Slim and stock devices give the same pass/fail over 3 full runs. One-command rollback tested. |
| P4 Parallel capacity | Right-size devices, unique ports, measured density. | Target density with no swap and no port collisions over 3 parallel runs. |
| P5 CI | Cache warm state between jobs, from internal sources only. | Cache hit rate known; the cache-miss path still green. |

## Baseline measurements (always in P0)

1. Cold boot to ready: Android `sys.boot_completed=1`; iOS `simctl bootstatus` done. Median of 3.
2. Warm boot from snapshot / an already-booted simulator. Median of 3.
3. Session start: `POST /session` to response, with the app already installed and without.
4. iOS: WDA first start against reuse (xcodebuild time in the Appium log).
5. Host memory per device, and how many fit before swap.
6. Flake rate over the last 50 runs, tagged by device, so later phases can show they did not raise it.

## Verdict sentence

Pick the first that applies:

1. Any high `DEP-*`/`NET-*` finding: "Blocked offline: some installs or steps need public network access. Fix P0 first; the rest depends on a reproducible install."
2. Any other high finding: "<n> high-impact gaps. Most of the gain is in P1 (warm-up, prebuilt WDA, snapshots): configuration only, no image changes."
3. Only medium/low: "In reasonable shape. Remaining gains are in lean images and right-sized devices (P2–P4); measure P0 first to prove them."
4. Nothing: "No gaps detected from what this host and project expose. Run the P0 baseline to confirm with numbers."
