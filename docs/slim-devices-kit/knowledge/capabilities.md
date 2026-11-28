# Appium capabilities that decide boot and session-start time

These are written with the `appium:` prefix, which Appium 2+ requires for non-W3C keys. Python and other clients often expose them as snake_case option properties: `use_prebuilt_wda` maps to `usePrebuiltWDA`. Search for both spellings.

The defaults below are the driver defaults in recent versions. Confirm them in the installed driver's own docs, which are available offline: `$APPIUM_HOME/node_modules/appium-<driver>-driver/docs/` or its `README.md`.

## Reset strategy (both platforms)

| Capability | Default | Effect | Recommended |
|---|---|---|---|
| `noReset` | false | `true`: keep app and data between sessions; no reinstall | `true`, with explicit resets in test hooks |
| `fullReset` | false | `true`: uninstall + reinstall the app (and on Android clear more) every session | `false`; one nightly job with `true` if wanted |
| `forceAppLaunch` (iOS) | true | Relaunch the app at session start even with `noReset` | Leave as is |
| `shouldTerminateApp` (iOS) | true | Terminate the app at session end | Leave as is |

Explicit resets instead of reinstalling:

- **Android:**
  - `driver.execute('mobile: clearApp', {appId})` (UiAutomator2), or `adb shell pm clear <pkg>`;
  - `mobile: terminateApp` + `mobile: activateApp`.
- **iOS:**
  - `mobile: terminateApp` + `mobile: launchApp`;
  - reset privacy with `simctl privacy <udid> reset all <bundle>`;
  - for a truly fresh app container, uninstall + install (still faster than a fresh simulator).

## Android (UiAutomator2)

| Capability | Default | Effect | Recommended |
|---|---|---|---|
| `disableWindowAnimation` | false | Turns animations off for the session and restores them after | `true`, or set animations to 0 in the snapshot |
| `skipServerInstallation` | false | Do not check/install the UiAutomator2 server | `true` only when the snapshot has the matching server version |
| `skipDeviceInitialization` | false | Skip settings-app install and device setup | `true` only when `io.appium.settings` is preinstalled |
| `systemPort` | 8200 | Host port forwarded to the UiAutomator2 server | Unique per parallel device (8200–8299) |
| `mjpegServerPort` | — | Screen streaming port | Unique per device if used |
| `chromedriverPort` | — | Chromedriver port for web views | Unique per device if used |
| `uiautomator2ServerLaunchTimeout` | 30000 | Wait for server start | 60000 on slow hosts |
| `uiautomator2ServerInstallTimeout` | 20000 | Wait for server install | 60000 |
| `adbExecTimeout` | 20000 | Per adb command | 60000 |
| `androidInstallTimeout` | 90000 | App install | 120000 for large apps |
| `autoGrantPermissions` | false | Grant all manifest permissions at install | `true` unless permission prompts are under test |
| `avd` | — | Driver launches this AVD if not running | Prefer launching the emulator yourself from a snapshot |
| `avdLaunchTimeout` / `avdReadyTimeout` | 60000 / 120000 | When the driver launches the AVD | 180000 each |
| `avdArgs` | — | Extra emulator flags when driver launches it | `-snapshot warm -no-snapshot-save -no-window -no-audio` |
| `isHeadless` | false | Headless emulator when the driver launches it | `true` on CI |
| `ignoreHiddenApiPolicyError` | false | Continue if hidden-API policy cannot be set | `true` on locked images |
| `appWaitActivity` / `appWaitDuration` | — / 20000 | Launch wait | Set `appWaitActivity` precisely to avoid waiting on splash screens |

## iOS (XCUITest)

| Capability | Default | Effect | Recommended |
|---|---|---|---|
| `usePrebuiltWDA` | false | Run WDA with `test-without-building` from `derivedDataPath` | `true` |
| `derivedDataPath` | Xcode default | Where the WDA build lives | A fixed folder per worker |
| `prebuiltWDAPath` | — | Path to a prebuilt `WebDriverAgentRunner-Runner.app` (used with `usePreinstalledWDA`) | When installing a prebuilt runner app |
| `usePreinstalledWDA` | false | Launch an already-installed WDA runner by bundle id instead of xcodebuild | Fastest; needs the runner installed on the simulator first |
| `updatedWDABundleId` | — | Bundle id of the runner | Needed with `usePreinstalledWDA` or real devices |
| `useXctestrunFile` + `bootstrapPath` | false | Use an `.xctestrun` from `bootstrapPath` | Alternative to `usePrebuiltWDA` |
| `webDriverAgentUrl` | — | Attach to a WDA already listening at this URL | Fastest; you own WDA's lifecycle |
| `useNewWDA` | false | Uninstall/restart WDA each session | `false` |
| `wdaLocalPort` | 8100 | Host port for WDA | Unique per simulator |
| `mjpegServerPort` | 9100 | Screen streaming | Unique per simulator if used |
| `wdaLaunchTimeout` | 60000 | Wait for WDA to start | 120000 |
| `wdaConnectionTimeout` | 240000 | Wait for WDA HTTP | Default |
| `wdaStartupRetries` / `wdaStartupRetryInterval` | 2 / 10000 | Retry a failed WDA start | 2 / 20000 |
| `simulatorStartupTimeout` | 120000 | Simulator boot wait when the driver boots it | 180000, or pre-boot (§2 of ios.md) |
| `isHeadless` | false | Do not show the Simulator window | `true` on CI |
| `reduceMotion` | false | Reduce motion in the simulator | `true` |
| `waitForQuiescence` | true | Wait for app idle before each action | `false` for apps with continuous animation; test both |
| `showXcodeLog` | false | Stream xcodebuild output | `false` except for debugging |
| `shutdownOtherSimulators` | false | Shut down other simulators at start | `false` in parallel pools (it would kill other workers) |

## Parallel runs: the port table to fill in per worker

| Worker | Device | Appium port | systemPort (Android) | wdaLocalPort (iOS) | mjpegServerPort | derivedDataPath (iOS) |
|---|---|---|---|---|---|---|
| 0 | emulator-5554 / sim UDID | 4723 | 8200 | 8100 | 9100 | `~/wda-build/<key>/w0` |
| 1 | emulator-5556 / sim UDID | 4725 | 8201 | 8101 | 9101 | `~/wda-build/<key>/w1` |

## Framework syntax reminders

- **WebdriverIO:** capability objects in `wdio.conf.*`, or a builder that `capabilities` imports. The worker index comes from the `capabilities` array position, or `process.env.WDIO_WORKER_ID`.
- **Java client:** `UiAutomator2Options` / `XCUITestOptions` setters (`setUsePrebuiltWda(true)`), or `caps.setCapability("appium:usePrebuiltWDA", true)`.
- **Python client:** `UiAutomator2Options()` / `XCUITestOptions()` attributes (`options.use_prebuilt_wda = True`), or `options.set_capability('appium:usePrebuiltWDA', True)`.
- **Robot Framework AppiumLibrary:** `Open Application` keyword arguments (`usePrebuiltWDA=true`).
