# iOS: simulator pre-warm, golden simulators, WebDriverAgent warm-up

Everything here uses only Xcode's tools (`xcrun simctl`, `xcodebuild`) and the Appium XCUITest driver, which ships WebDriverAgent (WDA) source in its npm package. No GitHub access is needed. All commands run on macOS.

## 1. Where the time goes

| Stage | Typical cold | Typical warm | Lever |
|---|---|---|---|
| Simulator boot to "booted" | 20–90 s (first boot after create/erase is the slowest) | 0 when kept booted; 5–15 s for a clone | §2, §3 |
| Post-boot settle (data migration, indexing) | 10–60 s on first boot | ~0 for a golden clone | §3 |
| WDA build (`xcodebuild build-for-testing`) | 30–120 s per session if not prebuilt | 0 | §5 |
| WDA launch (`test-without-building`) and HTTP up | 5–20 s | ~0 when an already-running WDA is reused | §6 |
| App install | 2–20 s | 0 with `noReset` + preinstalled | `capabilities.md` §Reset |

## 2. Pre-warm: boot before the run, keep booted

```sh
xcrun simctl boot <udid>                 # returns immediately
xcrun simctl bootstatus <udid>           # blocks until fully booted; add -b to boot if not yet booted
```

- Boot all worker simulators in parallel before the test run. Run `bootstatus` on each, then start Appium sessions.
- Keep them booted across sessions and runs, if Q7 allows. Shut down only at the end of the day or when the pool is resized:
  - `xcrun simctl shutdown <udid>`;
  - `xcrun simctl shutdown all`.
- Headless: Appium's `appium:isHeadless: true` keeps the Simulator app window closed. Booted simulators run without the Simulator UI app either way. Close `Simulator.app` on CI hosts to save memory.
- Reduce load:
  - `defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false` avoids keyboard-state flakes;
  - `appium:reduceMotion: true` turns off UI motion inside the simulator.

## 3. Golden simulator and clones

A **golden** simulator is prepared once per runtime and device type, then copied per worker. `simctl clone` is a fast disk copy, which beats `erase` followed by a first boot.

```sh
RT=com.apple.CoreSimulator.SimRuntime.iOS-17-5            # from: xcrun simctl list runtimes
DT="iPhone 15"                                             # or a device type id from: xcrun simctl list devicetypes
GOLD=$(xcrun simctl create "golden-iOS17.5-iPhone15" "$DT" "$RT")
xcrun simctl boot "$GOLD" && xcrun simctl bootstatus "$GOLD"
sleep 60                                                   # let first-boot work finish
xcrun simctl install "$GOLD" <path/to/App.app>             # if the app is stable between runs
xcrun simctl privacy "$GOLD" grant all <bundle.id>         # pre-grant permissions the tests need (see §7)
xcrun simctl shutdown "$GOLD"                              # a clone source must be shut down
for i in 0 1 2; do xcrun simctl clone "$GOLD" "worker-$i"; done
```

- Name clones predictably and record their UDIDs. Never hardcode UDIDs across hosts.
- Re-create the golden simulator when the runtime, Xcode or the preinstalled app changes. Store a `golden.meta` note with the Xcode version, runtime id and app version.
- Reset a dirty worker by deleting it and cloning again, rather than `erase` + first boot:
  - `xcrun simctl delete worker-1`;
  - `xcrun simctl clone "$GOLD" worker-1`.

## 4. Simulator hygiene

- `xcrun simctl delete unavailable` removes simulators whose runtime is no longer installed.
- `xcrun simctl list runtimes`, and on Xcode 15+ `xcrun simctl runtime list`, show what is installed. `xcrun simctl runtime delete <id>` removes an unused runtime image. Ask first: it is destructive.
- Simulator data lives in `~/Library/Developer/CoreSimulator/Devices/<udid>`. Logs are in `~/Library/Logs/CoreSimulator`.
- Too many simulators slow every `simctl list` and Xcode itself. Keep one golden simulator per runtime/type, plus the worker pool.

## 5. Build WebDriverAgent once

WDA source location, read offline:

```sh
WDA="${APPIUM_HOME:-$HOME/.appium}/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent"
[ -d "$WDA" ] || WDA="${APPIUM_HOME:-$HOME/.appium}/node_modules/appium-webdriveragent"
grep '"version"' "$WDA/package.json"
```

Build for simulators. One build serves all simulators of the same architecture and runtime family, but give each parallel worker its own copy of the derived data (§6):

```sh
xcodebuild build-for-testing \
  -project "$WDA/WebDriverAgent.xcodeproj" \
  -scheme WebDriverAgentRunner \
  -destination "platform=iOS Simulator,id=<udid>" \
  -derivedDataPath "$HOME/wda-build/<xcode-version>-<wda-version>" \
  CODE_SIGNING_ALLOWED=NO
```

Output:

- `<derivedDataPath>/Build/Products/Debug-iphonesimulator/WebDriverAgentRunner-Runner.app`;
- `<derivedDataPath>/Build/Products/WebDriverAgentRunner_iphonesimulator<sdk>-<arch>.xctestrun`.

Driver helper: `appium driver run xcuitest build-wda` builds the same thing. Run it only after checking its options in the installed driver's docs (`$APPIUM_HOME/node_modules/appium-xcuitest-driver/docs`). **Do not** use `download-wda-sim` on an offline network: it downloads prebuilt WDA from GitHub releases.

**Rebuild** when any of these changes:

- the Xcode version (`xcodebuild -version`);
- the WDA version;
- the simulator runtime's major version.

Key the folder name on those values, so a stale build is never picked up.

Real devices need signing: a team id, `-allowProvisioningUpdates`, and an `updatedWDABundleId`. That is out of scope for simulators. Document it separately if the project uses real iPhones.

## 6. Reuse WebDriverAgent per session

Three options, from least to most change:

**A. Prebuilt derived data** (simplest):

```json
{
  "appium:usePrebuiltWDA": true,
  "appium:derivedDataPath": "/Users/ci/wda-build/<xcode>-<wda>/<worker-udid>",
  "appium:wdaLocalPort": 8101,
  "appium:useNewWDA": false
}
```

- Copy or `rsync` the built derived data into one folder per worker. Parallel xcodebuild runs must not share a derived data folder.
- The driver runs `test-without-building`, skipping compilation.

**B. xctestrun file:**

```json
{
  "appium:useXctestrunFile": true,
  "appium:bootstrapPath": "/Users/ci/wda-build/<xcode>-<wda>/Build/Products",
  "appium:wdaLocalPort": 8101
}
```

The driver picks the `.xctestrun` matching the platform and SDK in `bootstrapPath`.

**C. Attach to an already-running WDA** (fastest; you own its lifecycle):

```sh
xcodebuild test-without-building -xctestrun <file>.xctestrun -destination "id=<udid>" &   # keep running per worker
# wait until: curl -s http://127.0.0.1:<port>/status   (local loopback only)
```

```json
{ "appium:webDriverAgentUrl": "http://127.0.0.1:8101" }
```

To make WDA listen on a non-default port, set `USE_PORT` in the xctestrun environment variables. Check your WDA version's docs for the variable name.

Port and process rules for parallel simulators:

- unique `appium:wdaLocalPort` (for example 8100 + worker index);
- unique `appium:mjpegServerPort` (9100 + index) if screen streaming is used;
- one Appium server port per worker, or one server with distinct capabilities;
- one derived data folder per worker.

Other session settings:

- `useNewWDA: false` reuses the WDA from the previous session on the same simulator. Set it to `true` only as a recovery step after a WDA crash.
- `wdaLaunchTimeout: 120000`, `wdaConnectionTimeout: 240000`, `wdaStartupRetries: 2` and `wdaStartupRetryInterval: 20000` absorb a slow first launch.
- `showXcodeLog: true` only while debugging. It is noisy, and it can include paths and environment details, so do not attach it to tickets.

## 7. Simulator capabilities through simctl (use instead of UI steps)

| Need | Command |
|---|---|
| Grant/revoke/reset privacy | `xcrun simctl privacy <udid> grant\|revoke\|reset <service> <bundle>`, where service is `all`, `camera`, `photos`, `location`, `location-always`, `contacts`, `calendar`, `microphone`, `motion`, `reminders`, `siri` |
| Location | `xcrun simctl location <udid> set <lat>,<lon>`; `clear` |
| Push notification | `xcrun simctl push <udid> <bundle> payload.apns` (JSON file) |
| Deep link | `xcrun simctl openurl <udid> "<uri>"` |
| Add photos/videos | `xcrun simctl addmedia <udid> file.jpg` |
| Appearance | `xcrun simctl ui <udid> appearance dark\|light` |
| Content size | `xcrun simctl ui <udid> content_size large` (and other sizes) |
| Status bar for screenshots | `xcrun simctl status_bar <udid> override --time 9:41 --batteryState charged --batteryLevel 100`; `clear` |
| Keychain / certificates | `xcrun simctl keychain <udid> add-root-cert cert.pem`; `reset` |
| Install / uninstall / launch / terminate | `xcrun simctl install\|uninstall\|launch\|terminate <udid> ...` |
| App container path | `xcrun simctl get_app_container <udid> <bundle> data` |
| Screenshot / video | `xcrun simctl io <udid> screenshot out.png`; `recordVideo out.mov` |
| Biometrics | Appium `mobile: enrollBiometric` / `mobile: sendBiometricMatch` (XCUITest driver) |

## 8. Slim profile with launchctl (phase P3, advanced, verify per runtime)

Simulators run a launchd of their own. Listing services is read-only:

```sh
xcrun simctl spawn <udid> launchctl list
```

Switching services off reduces CPU and memory per simulator. Labels differ between runtime versions, and the effect must be proved on each runtime:

1. **Choose candidates.** Work from `launchctl list` on the golden simulator. Pick only services unrelated to the app's needs from Q6, for example:
   - Siri and dictation, Spotlight indexing, Photos analysis, news/widgets, Game Center;
   - not `com.apple.backboardd`, `SpringBoard`, `com.apple.mobile.installd`, `testmanagerd`, or anything with `xctest`, `instruments` or `accessibility` in the name (WDA depends on them).
2. **Apply each service.**
   - Run `xcrun simctl spawn <udid> launchctl disable system/<label>` (or `bootout`, depending on the runtime). Then reboot the simulator to confirm it stays off.
   - Rollback: `launchctl enable system/<label>`, then reboot.
3. **Verify:**
   - the simulator boots;
   - WDA starts;
   - the full suite gives the same results as a stock clone;
   - measure memory with `ps -o rss` on the simulator's processes before and after.
4. **Keep it as a separate golden simulator** (`golden-...-slim`). Never modify the stock golden simulator.

Third-party tools that automate this exist. Treat them as untrusted until reviewed, and see `risks.md` §3. The steps above need nothing beyond Xcode.

## 9. Offline Xcode and runtimes

- **Xcode:** the `.xip` from your internal software distribution. `xcodebuild -runFirstLaunch` installs required components from the bundle; check it makes no network call on your version.
- **Simulator runtimes** (Xcode 15+ ships them separately):
  - `xcodebuild -importPlatform <path>/iOS_<version>_Simulator_Runtime.dmg`, or `xcrun simctl runtime add <path>.dmg`;
  - do **not** use `xcodebuild -downloadPlatform iOS`, which needs Apple's servers;
  - mirror the `.dmg` internally with a SHA-256.
- **Command Line Tools:** from the same distribution, or included with Xcode.
- **Appium XCUITest driver:** `appium driver install xcuitest@<pinned>` with npm set to the internal registry. WDA source comes with it.
