# Read-only probes

Every command here only reads. Run each with a timeout: 20 s by default, 60 s where marked. Record the facts listed under **Extract**, not the raw output. A missing tool is a fact too: record "not installed".

Shell notation:

- `sh` means macOS/Linux (bash or zsh).
- `ps` means Windows PowerShell.
- If both work, only `sh` is shown. On Windows, `.exe`, `.bat` and `.cmd` resolve automatically in PowerShell.

## 1. Host

| Fact | sh | ps |
|---|---|---|
| OS, version, arch | `uname -srm`; macOS: `sw_vers` | `Get-CimInstance Win32_OperatingSystem \| Select Caption,Version,OSArchitecture` |
| Logical CPUs | macOS `sysctl -n hw.logicalcpu`; Linux `nproc` | `(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors` |
| CPU model | macOS `sysctl -n machdep.cpu.brand_string`; Linux `grep -m1 'model name' /proc/cpuinfo` | `(Get-CimInstance Win32_Processor).Name` |
| RAM total | macOS `sysctl -n hw.memsize`; Linux `grep MemTotal /proc/meminfo` | `(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory` |
| Free disk (project volume) | `df -k .` | `Get-PSDrive -Name (Get-Location).Drive.Name` |
| Virtualisation (Android emulator speed) | Linux: `ls -l /dev/kvm` and `id -nG` (is the user in group `kvm`?); macOS: always available (Hypervisor.framework); Apple silicon needs `arm64-v8a` images | `emulator -accel-check` (see §3); also `(Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled` |

**Extract:**

- OS and arch;
- CPU count and model, and whether it is Apple silicon;
- RAM in GB;
- free disk in GB;
- acceleration usable: yes/no, with the reason.

## 2. Tools and versions

Run each with `--version`/`-v` and keep the first line.

| Tool | Command | Notes |
|---|---|---|
| Node.js | `node -v` | Compare with `engines.node` in the project and in the Appium/driver `package.json` (see `knowledge/dependencies-offline.md` §4). |
| npm | `npm -v` | Do **not** run `npm view`, `npm outdated` or `npm audit`; they use the network. |
| Java | `java -version` (prints to stderr) | Needed by UiAutomator2/Espresso tooling. Note the major version. |
| Appium | `appium -v` | Major 2 or 3 changes how drivers are installed and where they live. |
| adb | `adb version` | First line gives the platform-tools version. |
| Xcode | `xcodebuild -version`, `xcode-select -p` | macOS only. |
| Python | `python3 --version` | Only if the tests are in Python. |
| Others if present | `maestro --version`, `detox --version`, `applesimutils --version`, `idb --help` (presence only) | |

Appium drivers, installed list without the network. Read the folders:

```sh
ls "${APPIUM_HOME:-$HOME/.appium}/node_modules" | grep -E 'driver$'
cat "${APPIUM_HOME:-$HOME/.appium}/node_modules/appium-uiautomator2-driver/package.json"   # read "version", "peerDependencies.appium", "engines.node"
cat "${APPIUM_HOME:-$HOME/.appium}/node_modules/appium-xcuitest-driver/package.json"
ls node_modules | grep -E '^appium-.*-driver$'      # project-local drivers
```

```powershell
$ah = if ($env:APPIUM_HOME) { $env:APPIUM_HOME } else { "$HOME\.appium" }
Get-ChildItem "$ah\node_modules" -Directory | Where-Object Name -like '*driver'
Get-Content "$ah\node_modules\appium-uiautomator2-driver\package.json" | ConvertFrom-Json | Select version, engines, peerDependencies
```

`appium driver list --installed` is allowed: it reads the local manifest. Do **not** run `appium driver list` without `--installed`, because it may contact the registry.

**Extract:**

- each tool and its version, or "not installed";
- each driver with its version, and whether it is global (`APPIUM_HOME`) or project-local;
- the driver's required Appium and Node ranges;
- whether the installed versions satisfy those ranges.

## 3. Android SDK and AVDs

Find the SDK root, first hit wins:

1. `$ANDROID_HOME`;
2. `$ANDROID_SDK_ROOT`;
3. `~/Library/Android/sdk` (macOS), `~/Android/Sdk` (Linux), `%LOCALAPPDATA%\Android\Sdk` (Windows);
4. the parent of the folder holding `adb`.

| Fact | Command / file |
|---|---|
| Emulator version | `<sdk>/emulator/emulator -version` (first line) |
| Acceleration | `<sdk>/emulator/emulator -accel-check`, timeout 60 s. Exit code 0 means usable. Keep the line naming the hypervisor (KVM, WHPX, AEHD, HVF). |
| AVD list | `<sdk>/emulator/emulator -list-avds` |
| Installed system images | List folders `<sdk>/system-images/android-<api>/<tag>/<abi>/`. Tag is one of `default`, `google_apis`, `google_apis_playstore`, `aosp_atd`, `google_atd`, and others. |
| Command-line tools present | `<sdk>/cmdline-tools/latest/bin/sdkmanager` and `avdmanager` exist? Do **not** run `sdkmanager --list`: it uses the network. `sdkmanager --list_installed --offline` is allowed. |
| Platform-tools version | `<sdk>/platform-tools/source.properties`, key `Pkg.Revision` |

AVD folder: `$ANDROID_AVD_HOME`, else `$ANDROID_USER_HOME/avd`, else `~/.android/avd`. Each AVD has:

- `<name>.ini`, whose `path=` key points at the AVD folder;
- `<name>.avd/config.ini`, read these keys:

| Key | Meaning | Note |
|---|---|---|
| `hw.ramSize` | Guest RAM | Plain number = MB. Some versions write bytes or a `M`/`G` suffix: normalise. |
| `vm.heapSize` | Java heap per app | |
| `disk.dataPartition.size` | /data size | May be bytes or `6G` |
| `hw.cpu.ncore` | vCPUs | |
| `hw.gpu.enabled`, `hw.gpu.mode` | GPU | `auto`, `host`, `swiftshader_indirect`, `off` |
| `tag.id`, `PlayStore.enabled`, `image.sysdir.1`, `abi.type` | Image family | Play Store images cannot be rooted and auto-update apps. |
| `fastboot.forceColdBoot`, `fastboot.forceFastBoot` | Boot mode | `forceColdBoot=yes` disables Quick Boot. |
| `hw.camera.back`, `hw.camera.front` | Cameras | `emulated`/`webcam0` cost CPU. `none` if the app needs no camera. |
| `hw.audioInput`, `hw.audioOutput` | Audio | |

Snapshots: list `<name>.avd/snapshots/`. `default_boot` is the Quick Boot snapshot; any other folder is a named snapshot. Note the size of the AVD folder (`du -sh` / `Get-ChildItem -Recurse | Measure-Object Length -Sum`).

**Extract** per AVD:

- name, API level, tag, ABI, RAM, cores, GPU;
- Quick Boot snapshot yes/no, and named snapshots;
- whether a cold boot is forced;
- disk used.

Also extract which system images are installed. In particular, note whether an ATD image (`aosp_atd`/`google_atd`) is already there.

## 4. Running Android devices

```sh
adb devices -l          # keep serials in state "device"; note "unauthorized"/"offline"
```

For each serial, at most 6. Each is one `adb -s <serial> shell <cmd>` with a 15 s timeout:

| Fact | Command | Read |
|---|---|---|
| API / release / model | `getprop ro.build.version.sdk`; `getprop ro.build.version.release`; `getprop ro.product.model` | |
| Emulator? | `getprop ro.kernel.qemu` (`1` = emulator) or serial `emulator-NNNN` | |
| Boot finished | `getprop sys.boot_completed` | `1` |
| Animations | `settings get global window_animation_scale`, `transition_animation_scale`, `animator_duration_scale` | `0` or `0.0` = off |
| Install verification | `settings get global verifier_verify_adb_installs` | `0` = off |
| Stay awake | `settings get global stay_on_while_plugged_in` | `7` = always on |
| Package counts | `pm list packages -e \| wc -l` (enabled), `pm list packages -d \| wc -l` (disabled) | |
| Google Play Services | `pm list packages com.google.android.gms` | present / absent |
| Appium helpers preinstalled | `pm list packages io.appium` | `io.appium.uiautomator2.server`, `io.appium.uiautomator2.server.test`, `io.appium.settings` |
| App under test installed | `pm list packages <appPackage>` and `dumpsys package <appPackage> \| grep versionName` | |
| Memory | `cat /proc/meminfo` | `MemTotal`, `MemAvailable` |
| Hidden-API policy (only if the app uses reflection) | `settings get global hidden_api_policy` | |
| Running services (optional) | `dumpsys activity services \| grep -c ServiceRecord` | A rough load indicator |

On Windows PowerShell, count lines with `(adb -s $s shell pm list packages -e).Count`.

**Never** read emulator console output, `logcat` dumps of the whole device, or crash-report folders.

## 5. Xcode and simulators (macOS only)

| Fact | Command | Timeout |
|---|---|---|
| Xcode | `xcodebuild -version`; `xcode-select -p` | 20 s |
| Runtimes | `xcrun simctl list -j runtimes` | 60 s |
| Simulators | `xcrun simctl list -j devices` | 60 s |
| Runtime disk images (Xcode 15+) | `xcrun simctl runtime list` | 60 s |
| Simulator data size | `du -sh ~/Library/Developer/CoreSimulator/Devices` | 60 s, optional |
| Services in a booted simulator | `xcrun simctl spawn <udid> launchctl list \| wc -l` | 30 s, booted only, at most 6 |
| Simulator app prefs | `defaults read com.apple.iphonesimulator 2>/dev/null` | keys `ConnectHardwareKeyboard`, `ShowChrome` |

From the JSON:

- for each runtime: `name`, `identifier`, `isAvailable`, `version`;
- for each device: `name`, `udid`, `state` (`Booted`/`Shutdown`), `isAvailable`, `deviceTypeIdentifier`, with its runtime key.

**Extract:**

- Xcode version;
- runtimes installed;
- simulator count, booted count, and unavailable count (runtime removed);
- per booted simulator: name, runtime, service count.

## 6. WebDriverAgent

WDA source ships inside the XCUITest driver npm package. No GitHub access is needed:

```sh
D="${APPIUM_HOME:-$HOME/.appium}/node_modules/appium-xcuitest-driver"
ls "$D/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj" 2>/dev/null || ls "${APPIUM_HOME:-$HOME/.appium}/node_modules/appium-webdriveragent"
grep '"version"' "$D/node_modules/appium-webdriveragent/package.json"
```

Prebuilt WDA:

```sh
find ~/Library/Developer/Xcode/DerivedData -maxdepth 6 -name 'WebDriverAgentRunner-Runner.app' -prune 2>/dev/null
find ~/Library/Developer/Xcode/DerivedData -maxdepth 6 -name '*WebDriverAgent*.xctestrun' 2>/dev/null
# plus every derivedDataPath / prebuiltWDAPath / bootstrapPath found in the project's capabilities
stat -f '%Sm' <path-to-Runner.app>       # build time; compare with the Xcode install date: ls -ld "$(xcode-select -p)/../.."
```

**Extract:**

- WDA source version;
- prebuilt runner apps and xctestrun files, with paths and build times;
- whether a build is older than the current Xcode, which makes it stale;
- whether the capabilities point at one of them.

## 7. Optional measurements (ask first, one by one)

These change device state. Describe each one and run it only after the user says yes to that one.

| Measurement | What it does | Leaves behind |
|---|---|---|
| Android cold boot time | `emulator -avd <name> -no-snapshot-load -no-snapshot-save -no-window -no-audio`, then time until `sys.boot_completed=1`, then `adb emu kill` | Nothing (no snapshot saved) |
| Android warm boot time | Same with `-snapshot <name> -no-snapshot-save` | Nothing |
| iOS boot time | `xcrun simctl boot <udid>`; time `xcrun simctl bootstatus <udid>`; `xcrun simctl shutdown <udid>` | Simulator returns to shutdown |
| Session start time | Start one Appium session with the project's own capabilities and time `POST /session` to its response | App may be installed. Appium helper apps may be installed. |
| WDA build time | `xcodebuild build-for-testing` for WDA into a scratch `-derivedDataPath` | A build folder, which you can delete |

Record the median of 3 runs. Never include console output in the report.
