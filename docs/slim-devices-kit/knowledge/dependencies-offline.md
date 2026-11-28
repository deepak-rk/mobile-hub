# Dependencies on a network without public GitHub

## 1. Principle

Every component the device setup needs must come from one of:

1. **OS vendor tooling already on the machine:** Xcode, the Android SDK packages present;
2. **the organisation's internal package registry or proxy:** npm, PyPI, Maven, RubyGems;
3. **the organisation's internal artifact store**, for files that are not packages: SDK zips, simulator runtime `.dmg`s, Xcode `.xip`. Each file is stored with a SHA-256.

Anything else is a finding: `DEP-GIT`, `NET-GITHUB` or `NET-CURLSH` in `CHECKS.md`.

## 2. Component sourcing table

Put this table in the report, filled in for the project. Mark each row OK, Gap or Unknown for this project.

| Component | Needed for | Offline source | How to install offline | Pin by | Verify |
|---|---|---|---|---|---|
| Android SDK platform-tools (adb) | Android | Internal SDK mirror or prepared SDK folder | `sdkmanager "platform-tools"` against the mirror, or copy the folder | `Pkg.Revision` in `source.properties` | `adb version` |
| Android emulator | Android emulators | Same | `sdkmanager "emulator"` | `Pkg.Revision` | `emulator -version` |
| System images | Android emulators | Same | `sdkmanager "system-images;android-<api>;<tag>;<abi>"` | Image revision | `<sdk>/system-images/.../source.properties` |
| Java (JDK) | UiAutomator2 build tools, Gradle | Internal JDK distribution | OS package from the internal repo | Major + update | `java -version` |
| Node.js | Appium, JS test frameworks | Internal Node distribution / OS package repo | Installer or archive from the internal store | Exact version | `node -v` |
| Appium server | Appium-based tests | Internal npm registry | `npm i -g appium@<x.y.z>`, or a project devDependency + `npx appium` | Exact version | `appium -v` |
| UiAutomator2 driver | Android | Internal npm registry | `appium driver install uiautomator2@<x.y.z>` (Appium uses npm, so registry settings apply) | Exact version | `appium driver list --installed` |
| XCUITest driver (includes WebDriverAgent source) | iOS | Internal npm registry | `appium driver install xcuitest@<x.y.z>` | Exact version | Same; WDA version from its `package.json` |
| WebDriverAgent build | iOS | Built locally | `xcodebuild build-for-testing` (`ios.md` §5) | Xcode + WDA version | Runner app exists |
| Xcode | iOS | Internal software distribution | `.xip` | Exact build | `xcodebuild -version` |
| Simulator runtimes | iOS | Internal artifact store | `xcodebuild -importPlatform <dmg>` | Runtime build | `xcrun simctl list runtimes` |
| Test framework and clients | Tests | Internal registry | Lockfile install (`npm ci`, `pip install -r … --require-hashes`) | Lockfile | Lockfile committed |
| CI actions/plugins | CI | Internal mirror of actions/plugins | Reference the internal copy pinned to a full commit SHA | Commit SHA | CI config |

## 3. Registry wiring

Do not read the files; describe what must be true.

- **npm:** the user- or project-level `.npmrc` sets `registry=` to the internal registry. Appium's `driver install` and `plugin install` run npm and honour the same configuration. Setting `APPIUM_HOME` per project keeps drivers next to the project and reproducible.
- **pip:** `pip.conf` / `PIP_INDEX_URL` points at the internal index. Use `--require-hashes` for reproducibility.
- **Maven/Gradle:** `settings.xml` mirrors / `repositories {}` point at the internal proxy. Avoid JitPack-style GitHub coordinates.
- **Git submodules or `git+` dependencies:** replace them with packages in the internal registry, or vendor them with a checksum.

## 4. Checking compatibility without the network

Read the versions from files already installed:

| Question | Where to read |
|---|---|
| Which Appium version does a driver need? | `$APPIUM_HOME/node_modules/<driver>/package.json` → `peerDependencies.appium` |
| Which Node does it need? | Same file → `engines.node`; also Appium's own `package.json` `engines.node` |
| Which WDA version ships with the XCUITest driver? | `.../appium-webdriveragent/package.json` → `version` |
| Which Xcode does the driver support? | The driver's `docs/` or `README.md` in `node_modules`; its `CHANGELOG.md` |
| Which API levels does the emulator/image support? | `<sdk>/emulator/source.properties`, `<sdk>/system-images/.../source.properties` |
| What changed between two driver versions? | `CHANGELOG.md` inside the installed package; an internal registry UI if one exists |

Report mismatches as `DEP-DRIVER-SKEW`. Never "fix" them by installing from the network during the analysis.

## 5. Supply-chain controls for device tooling

- Pin exact versions. No `latest`, and no unpinned driver installs.
- Keep checksums for every non-package file in the artifact store, and verify them before install.
- Review any script that changes device system state (slim profiles) like code: an owner, a review, a changelog.
- Do not run install scripts piped from remote URLs.
- Prefer vendor tools over third-party wrappers. A wrapper is worth adopting only if it is mirrored, pinned, reviewed, and its function cannot reasonably be done with `adb`/`emulator`/`simctl`/`xcodebuild` directly.
