# Android: pre-warm, lean devices, adb capabilities

Everything here uses only the Android SDK (`emulator`, `adb`, `avdmanager`, `sdkmanager`) and the Appium UiAutomator2 driver. Commands are `sh`. In PowerShell, replace the `until` loops with `do { Start-Sleep 2 } until ((adb shell getprop sys.boot_completed).Trim() -eq '1')`.

## 1. Where the time goes

| Stage | Typical cold | Typical warm | Lever |
|---|---|---|---|
| Emulator start to `sys.boot_completed=1` | 40–120 s | 3–10 s from snapshot | §3 snapshots, §5 image, §6 sizing |
| Post-boot settle (package manager, media scanner, Play updates) | 10–60 s | ~0 if done before the snapshot | §3, §5 |
| Appium session: install UiAutomator2 server + settings app | 5–20 s | ~0 when preinstalled | §4 |
| App install | 2–30 s | 0 with `noReset` + preinstalled | `knowledge/capabilities.md` §Reset |
| Animations during tests | adds waits, causes flakes | 0 | §2 |

## 2. One-time device settings (put them in the warm snapshot)

```sh
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
adb shell settings put global verifier_verify_adb_installs 0      # no "verify app" scan on adb installs
adb shell settings put global stay_on_while_plugged_in 7          # screen never sleeps
adb shell settings put system screen_off_timeout 2147483647
adb shell locksettings set-disabled true                          # no lock screen (API 28+)
adb shell settings put secure show_ime_with_hard_keyboard 0       # avoid soft keyboard covering views (if tests type via adb)
adb shell settings put global auto_time 1                         # keep clock sane after snapshot restore
```

Revert each with the same key and its previous value: record the previous values first with `settings get`.

## 3. Snapshot pre-warm

Quick Boot saves `default_boot` on exit unless told not to. For tests, use a **named snapshot** prepared once and never overwritten by runs.

Prepare (once per AVD, and again whenever the system image, emulator or Appium driver version changes):

```sh
emulator -avd <AVD> -no-window -no-audio -no-boot-anim -no-snapshot-load &
adb -s emulator-5554 wait-for-device
until [ "$(adb -s emulator-5554 shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done
sleep 30                                   # let package manager / media scanner settle
# apply §2 settings
# install the app under test if it is stable between runs; otherwise skip
# run ONE Appium session against this device so the UiAutomator2 server + io.appium.settings get installed
adb -s emulator-5554 emu avd snapshot save warm
adb -s emulator-5554 emu kill
```

Each run:

```sh
emulator -avd <AVD> -snapshot warm -no-snapshot-save -read-only -no-window -no-audio -no-boot-anim -port 5554 &
adb -s emulator-5554 wait-for-device
until [ "$(adb -s emulator-5554 shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 1; done
```

Flags:

| Flag | Effect |
|---|---|
| `-snapshot <name>` | Load and (unless told otherwise) save that named snapshot |
| `-no-snapshot-save` | Do not write back on exit: every run starts from the same clean state |
| `-no-snapshot-load` | Force a cold boot (use only to prepare) |
| `-read-only` | Run several instances of the **same** AVD at once (each gets temporary writable layers). Pair with distinct `-port` values (even numbers 5554–5682). |
| `-no-window -no-audio -no-boot-anim` | Headless, no audio device, skip boot animation |
| `-gpu swiftshader_indirect` | Software GPU for hosts without one (CI). `-gpu host` when a real GPU exists. |
| `-memory <MB>`, `-cores <n>` | Override RAM/CPUs for this run without editing config.ini |
| `-netdelay none -netspeed full` | No network throttling |
| `-camera-back none -camera-front none` | No emulated cameras when the app does not need them |

Other snapshot commands through the emulator console: `adb emu avd snapshot list`, `adb emu avd snapshot load <name>`, `adb emu avd snapshot delete <name>`.

**Invalidate** the snapshot when any of these changes: system image revision (`<sdk>/system-images/.../source.properties` `Pkg.Revision`), emulator version, AVD `config.ini`, UiAutomator2 driver version, or app version (if preinstalled). Store a small `warm.meta` next to it with those values. A run that finds a mismatch should re-prepare rather than use a stale snapshot.

## 4. UiAutomator2 warm-up

- A session installs `io.appium.uiautomator2.server`, `io.appium.uiautomator2.server.test` and `io.appium.settings` when they are missing or a different version. Preinstalling them inside the snapshot removes that.
- With the helpers known to be present at the right version, `appium:skipServerInstallation: true` skips the version check and install. Set it only after the snapshot was prepared with the same driver version, or sessions fail with a server mismatch.
- `appium:skipDeviceInitialization: true` skips pushing the settings app and setting up the device. Only use it when `io.appium.settings` is already installed and permissions for it are granted.
- Keep the server alive between sessions on the same device: avoid `appium:fullReset`, and use one Appium server per device.
- Timeouts that avoid false failures on a slow host:
  - `appium:uiautomator2ServerLaunchTimeout: 60000`;
  - `appium:uiautomator2ServerInstallTimeout: 60000`;
  - `appium:adbExecTimeout: 60000`;
  - `appium:androidInstallTimeout: 120000`.

## 5. Lean images (first-party "slim")

| Image tag | Contents | Use when |
|---|---|---|
| `aosp_atd` | Automated Test Device image, AOSP-based: many apps and services removed, tuned for headless tests | App needs no Google APIs |
| `google_atd` | ATD image with Google APIs | App needs Google APIs but not the Play Store |
| `default` | Plain AOSP | Older API levels without ATD |
| `google_apis` | Google APIs, rootable (`adb root`) | App needs Play Services APIs (maps, FCM) |
| `google_apis_playstore` | Play Store, not rootable, auto-updates apps | Only if tests need the Play Store itself |

ATD images exist for API 30 and later, in `x86_64` and, for some levels, `arm64-v8a`.

They are a fair choice for most functional tests. Keep at least one stock `google_apis` device in the run as a control (`knowledge/risks.md` §2).

Create from the command line:

```sh
avdmanager create avd -n <name> -k "system-images;android-34;google_atd;x86_64" -d pixel_6
```

## 6. AVD sizing (`<name>.avd/config.ini`)

```ini
hw.ramSize=2048            # 2–3 GB for most apps; measure with: adb shell dumpsys meminfo <package>
vm.heapSize=256            # 256–576
disk.dataPartition.size=4G # 4–6 GB unless the app stores a lot
hw.cpu.ncore=2             # 2–4; more cores past 4 rarely helps tests
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect   # or host when a GPU exists
hw.camera.back=none
hw.camera.front=none
hw.audioInput=no
hw.audioOutput=no
fastboot.forceColdBoot=no
showDeviceFrame=no
```

Changing `config.ini` invalidates snapshots: re-prepare them.

## 7. Slim profile with adb (phase P3, opt-in)

The goal is fewer background processes, so more devices fit per host and runs flake less. Every step must be reversible and verified.

1. List candidates: `adb shell pm list packages -e -s` (system packages that are enabled).
2. Build an **allow-list file** (`slim-profile.android.txt`): one package per line, each with a reason. Never include:
   - `android`, `com.android.systemui`, `com.android.settings`, `com.android.providers.*`, `com.android.phone`, `com.android.shell`;
   - the launcher;
   - any `io.appium.*` package;
   - the WebView provider (`com.google.android.webview` / `com.android.webview`) if Q6 includes web views;
   - `com.google.android.gms` and `com.google.android.gsf` if Q6 includes Play Services or push;
   - the camera or location providers if Q6 needs them.
3. Apply each package: `adb shell pm disable-user --user 0 <package>`.
   - Rollback: `adb shell pm enable <package>`.
   - Prefer this over `pm uninstall -k --user 0 <package>`, whose rollback is `adb shell cmd package install-existing <package>`.
4. Verify:
   - `pm list packages -d` contains exactly the list;
   - the device still reaches `sys.boot_completed=1` after a reboot;
   - the full suite passes on slim and on a stock control device.
5. Save the result as a separate named snapshot (`slim`), not over `warm`.

Typical low-risk candidates on Google images:

- Play Store auto-update (`com.android.vending`), only when Play is not needed;
- YouTube, Maps, Gmail, Photos, Music, Chrome. Not Chrome if the app opens external links, or if web views on that API level are backed by Chrome;
- the wallpaper picker, live wallpapers, the print spooler, demo/retail mode, and the feedback/bug-report apps.

On ATD images most of these are already gone, which is why §5 comes before §7.

## 8. Device capabilities through adb (use instead of UI steps)

| Need | Command |
|---|---|
| Grant runtime permission | `adb shell pm grant <pkg> android.permission.CAMERA` (or capability `appium:autoGrantPermissions: true`) |
| Revoke / reset permissions | `adb shell pm revoke <pkg> <perm>`; `adb shell pm reset-permissions` |
| App ops (background location, etc.) | `adb shell appops set <pkg> <OP> allow` |
| Clear app data | `adb shell pm clear <pkg>` (or `mobile: clearApp`) |
| Deep link | `adb shell am start -W -a android.intent.action.VIEW -d "<uri>" <pkg>` |
| Locale | Appium capabilities `appium:language` / `appium:locale`, or `io.appium.settings` broadcast |
| Location | `adb emu geo fix <lon> <lat>` (emulator) |
| Network | `adb shell svc wifi enable\|disable`; `adb shell svc data enable\|disable`; `adb shell cmd connectivity airplane-mode enable\|disable` (API 30+) |
| Battery state | `adb shell dumpsys battery unplug`, `set level 15`, `reset` |
| Screen size/density | `adb shell wm size 1080x1920`, `adb shell wm density 420`, `reset` |
| Doze / idle | `adb shell dumpsys deviceidle force-idle`, `unforce` |
| Dark mode | `adb shell cmd uimode night yes\|no` |
| Push file / media | `adb push <file> /sdcard/Download/`; then `adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/<file>` |
| Precompile app (faster first launch) | `adb shell cmd package compile -m speed -f <pkg>` |
| Free space between runs | `adb shell pm trim-caches 4G` |

## 9. Offline SDK

Without public network access, `sdkmanager` must use one of the following:

1. **An internal mirror of the SDK repository.** A proxy or artifact store mirrors the repository XML and zips. Point the tools at it:
   - `sdkmanager --proxy=http --proxy_host=<host> --proxy_port=<port> ...`;
   - or set `SDK_TEST_BASE_URL=<internal-url>/` for the repository base; check this name against your SDK tools version.
   - Install exact package ids: `"platform-tools"`, `"emulator"`, `"platforms;android-34"`, `"system-images;android-34;google_atd;x86_64"`.
2. **A prepared SDK folder copied in.** Copy a folder built on a connected machine with the same OS. Every package folder must keep its `package.xml` and `source.properties`. Then run `sdkmanager --list_installed --offline` to confirm.
3. **Package zips from the internal artifact store.** Unzip into the right path:
   - `system-images/android-34/google_atd/x86_64/`, with `package.xml` present;
   - accept licences offline by copying the `licenses/` folder from a machine where they were accepted.

Record SHA-256 of every zip in the mirror. Pin the emulator version, because snapshots are only valid with the version that wrote them.
