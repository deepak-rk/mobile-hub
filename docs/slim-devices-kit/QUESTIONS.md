# Questions

Ask only what the project does not answer. Send all of them in one message, at most 6. For each one you inferred, show the inferred value so the user can correct it.

| # | Question | Options | Why it matters | Infer from | Default if unanswered |
|---|---|---|---|---|---|
| Q1 | Which platforms do the tests target? | android / ios / both | Decides which half of the analysis carries weight. | See "Platform inference" below. | What the inference finds; else `both` |
| Q2 | Where do device tests run today? | local machines / hosted CI runners / self-hosted lab hosts / device cloud / mixed | Hosted runners start empty each job, so warm state must be cached or rebuilt. A lab keeps devices warm between runs. A device cloud makes most of this report advisory only. | CI files that start emulators/simulators or run Appium (not just lint); cloud hostnames in capabilities (`browserstack`, `saucelabs`, `lambdatest`, `perfecto`, `kobiton`, `bitbar`, `aws devicefarm`). | `local` if devices are attached to this host, else `mixed` |
| Q3 | What matters most? (one or more) | faster boot / faster session start / more devices per host / less flakiness / lower cost | Orders the action plan and the verdict. | Usually cannot be inferred. | `faster session start`, `less flakiness` |
| Q4 | How many devices should one host run in parallel? | a number | Sizes RAM/CPU and decides which ports must be unique per device. | `maxInstances`, `maxInstancesPerCapability`, worker/shard counts, CI matrix size. | Current setting; else 2 |
| Q5 | Can the setup use anything beyond the OS vendor SDKs and your internal package registry? | no, vendor SDKs + internal mirror only / vetted internal mirror of third-party tools / yes | With no public network access, every component needs an offline source. This also governs third-party "slim" tools. | Registry config files exist (names only); air-gap mentioned in docs. | `no` |
| Q6 | Which device services does the app use? (one or more) | Google Play Services / push notifications / camera / location / biometrics / in-app web views or browser / contacts or photos / none of these | Decides which device image to use and which system packages or daemons are safe to switch off. Getting this wrong is the main slimming risk. | Android manifest permissions and dependencies (`com.google.android.gms`, `firebase-messaging`, `CAMERA`, `ACCESS_FINE_LOCATION`, `USE_BIOMETRIC`); iOS `Info.plist` usage strings (`NSCameraUsageDescription`, `NSLocationWhenInUseUsageDescription`, `NSFaceIDUsageDescription`), push entitlements; capabilities such as `chromedriver*` or `webviewConnectTimeout`. These are only present if the app source is in this repo. | Assume all of them (most conservative) |

Optional follow-ups, only when relevant:

- **Q7** (macOS hosts): may simulators stay booted between runs, or must every run start from a cold, clean device? Decides whether a warm-pool design is allowed.
- **Q8** (labs): can devices be set up with an admin account (Android: `adb root` on non-Play images; macOS: admin user)? Decides which slim-profile steps are possible.

## Platform inference

Android is in scope when any of these holds:

- capability `platformName` is `Android`;
- `automationName` is `UiAutomator2` or `Espresso`;
- the code mentions those names in a platform map;
- an `android` folder holds instrumentation tests;
- scripts call `adb` or `emulator`.

iOS is in scope when:

- `platformName` is `iOS`;
- `automationName` is `XCUITest`;
- the project has an `*.xcodeproj` / `*.xcworkspace` with a UI-test target, or Swift files using `XCUIApplication`;
- scripts call `simctl` or `xcodebuild`.

Check maps and switch statements (for example `PLATFORM_NAME[platform]`) and npm scripts like `test:ios`. Capability builders often hide the second platform behind an env variable.

## Answers record

Write this as `device-setup-answers.md` in the project root after the user replies:

```markdown
# Device setup answers
Recorded: <date>  Host: <os, hostname not required>

| # | Answer | Source |
|---|---|---|
| Q1 | both | inferred: config/capabilities.ts:71 platform map |
| Q2 | local | answered |
| Q3 | faster session start, less flakiness | default |
| Q4 | 2 | answered |
| Q5 | no | answered |
| Q6 | push, camera, web views | answered |

Notes from the user:
- <anything they added>
```

Sources are `answered`, `inferred: <evidence>`, or `default`.
