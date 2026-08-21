# Infrastructure Requirements

What you actually need — hardware, OS, and software — to run Mobile Hub. Split into three roles: the **central server** (backend + MongoDB), **Android agent hosts**, and **iOS agent hosts**. These roles can run on the same machine for a single-contributor setup, or on separate machines for a shared community lab.

---

## 1. Central server (backend + MongoDB)

The backend that serves the REST API, WebSocket, and frontend. Does not need to be on the same machine as any device.

### Hardware
| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 2 cores | 4 cores |
| RAM | 2 GB | 4 GB |
| Disk | 10 GB (OS + Docker) | 40 GB+ (grows with run logs, build artifacts, Allure reports) |

### OS
- **Linux** (Ubuntu 22.04 LTS or later) — recommended for production
- **macOS** (12 Monterey or later) — fine for single-contributor setups
- **Windows 11** — supported for local dev; Docker Desktop required

### Software
| Software | Version | Notes |
|---|---|---|
| Docker | 24+ | Required for `docker compose up` deployment |
| Docker Compose | v2 (bundled with Docker Desktop / Docker Engine 24+) | `docker compose` (not `docker-compose`) |
| Node.js | 20 LTS or 22 LTS | Only needed for local dev without Docker |
| npm | 10+ | Bundled with Node.js 20+ |
| MongoDB | 7.0 | Runs in Docker; or use Atlas free tier (M0) |

### Ports to open (inbound)
| Port | Purpose |
|---|---|
| `80` / `443` | Frontend (Nginx) |
| `3000` | Backend REST API + execution WebSocket + SSE |
| `3001` | Stream WebSocket (separate port — required for grid views with 3+ devices) |

MongoDB port `27017` must **not** be exposed publicly — internal only.

---

## 2. Android agent host

Any machine with USB access to Android devices (or emulators). Can be Linux, macOS, or Windows.

### Hardware
| Resource | Minimum | Notes |
|---|---|---|
| CPU | 2 cores | More cores = more parallel Appium instances |
| RAM | 4 GB | Add ~500 MB per simultaneously running Appium server |
| Disk | 20 GB | Build artifacts cache + workspace dirs accumulate; plan for growth |
| USB | USB-A or USB-C ports matching device count | USB hub works; powered hub recommended for 4+ devices |

### OS
- **Linux** (Ubuntu 22.04+) — best ADB reliability; recommended for shared labs
- **macOS** (12+) — works; required if same host also does iOS
- **Windows 11** — works; ADB driver installation required per device model

### Required software
| Software | How to get | Notes |
|---|---|---|
| **Node.js 20 LTS** | [nodejs.org](https://nodejs.org) or `nvm` | Runs the Mobile Hub agent |
| **ADB** (Android Debug Bridge) | Part of Android SDK Platform Tools | `adb devices` must work from terminal |
| **Android SDK Platform Tools** | Android Studio → SDK Manager, or standalone download | Minimum version: 34 (for Android 14 support) |
| **Appium 2.x** | `npm install -g appium` | One Appium server per device; plugin management per project |
| **Appium UiAutomator2 driver** | `appium driver install uiautomator2` | Required for Android automation |
| **Java** (JDK 11 or 17) | Eclipse Temurin recommended | Required by Appium / UiAutomator2 |

### Android device requirements
- **Android 5.0 (API 21) minimum** — Mobile Hub targets Android 14+ but will work on older if ADB works
- **USB debugging enabled** (Settings → Developer options → USB debugging)
- **Developer options unlocked** (Settings → About phone → tap Build number 7×)
- **Screen stay on while charging** recommended (Settings → Developer options)
- **Trust this computer** accepted on first USB connection

### Environment variables (agent host)
```bash
ANDROID_HOME=/path/to/android-sdk    # e.g. ~/Library/Android/sdk on macOS
PATH=$PATH:$ANDROID_HOME/platform-tools
```

Verify with: `adb devices -l` — should list connected devices without errors.

---

## 3. iOS agent host

**Must be a Mac.** Apple's toolchain (`xcrun`, `xcodebuild`, WebDriverAgent) only runs on macOS. There is no workaround.

### Hardware
| Resource | Minimum | Recommended | Notes |
|---|---|---|---|
| CPU | Apple M1 (or Intel Core i5) | Apple M2 or M3 | M-series handles more simultaneous simulators |
| RAM | 8 GB | 16 GB | Each iOS simulator uses ~1 GB RAM |
| Disk | 50 GB free | 100 GB+ | Xcode is ~12 GB; simulator runtimes are 4–8 GB each; build artifacts add up |
| USB | USB-C / Lightning ports or hub | Powered hub for 4+ physical devices | |

### OS
- **macOS 13 Ventura or later** — required for iOS 17+ physical device support (QUIC/RemoteXPC)
- **macOS 14 Sonoma or later** — recommended; better Simulator performance

### Required software

#### Xcode Command Line Tools (free)
The minimum requirement — you do not need the full Xcode IDE for simulator streaming:

```bash
xcode-select --install
```

This installs `xcrun`, `simctl`, and related tools. It is **free** and does not require a paid Apple account.

Verify:
```bash
xcrun simctl list devices    # should list available simulators
xcode-select -p              # should print a path (e.g. /Library/Developer/CommandLineTools)
```

#### Xcode (free — required for physical iOS devices and simulator runtimes)
- Download from the **Mac App Store** (free)
- Required to download iOS simulator runtimes and to build/sign WebDriverAgent for physical devices
- Version: **Xcode 15 or later** (for iOS 17 support); **Xcode 16** for iOS 18
- After install, accept the license: `sudo xcodebuild -license accept`

Verify:
```bash
xcodebuild -version          # e.g. Xcode 16.0
xcrun simctl list runtimes   # should list installed simulator runtimes
```

#### Appium 2.x + XCUITest driver
```bash
npm install -g appium
appium driver install xcuitest
```

The XCUITest driver builds and deploys **WebDriverAgent (WDA)** onto each iOS device. WDA is bundled inside the driver — you do not download it separately.

Verify:
```bash
appium driver list --installed    # should show xcuitest
```

#### WebDriverAgent (WDA) — for physical iOS devices
WDA is the on-device server that Appium communicates with. It requires:

1. An **Apple Developer account** (free tier works for physical devices on your own dev team; paid account required for distribution)
2. A **provisioning profile** and **code signing identity** configured in Xcode for the WDA project
3. WDA installed onto each physical device via `appium driver run xcuitest open-wda` or manually via Xcode

For **simulators**, no Apple Developer account is needed — WDA runs without signing.

#### Node.js 20 LTS
Same as Android hosts — runs the Mobile Hub agent process.

### iOS device requirements

#### Simulators (no Apple account needed)
- Installed via Xcode → Settings → Platforms → iOS (download the runtime for the target version)
- No physical device, no signing, no account
- Maximum **8 concurrent simulator streams per Mac host** (hard cap enforced by Mobile Hub — xcrun drops frames silently beyond this)

#### Physical iOS devices
- iOS 16 or later recommended; iOS 17+ requires macOS 13+ and Xcode 15+ for WDA compatibility (Apple changed the protocol from TCP to QUIC/RemoteXPC in iOS 17)
- **Developer mode enabled** (Settings → Privacy & Security → Developer Mode) — required on iOS 16+
- Device **trusted** on the Mac (cable connect → "Trust This Computer" on device)
- **Apple Developer account** for WDA provisioning (free account sufficient for personal device testing)
- USB connection — Lightning or USB-C depending on device model

---

## 4. Summary matrix

| Host role | Linux | macOS | Windows | Apple account | Xcode | ADB |
|---|---|---|---|---|---|---|
| Central server | ✅ best | ✅ | ✅ | ✗ | ✗ | ✗ |
| Android agent | ✅ best | ✅ | ✅ | ✗ | ✗ | ✅ required |
| iOS agent (simulators only) | ✗ | ✅ required | ✗ | ✗ | ✅ free | ✗ |
| iOS agent (physical devices) | ✗ | ✅ required | ✗ | ✅ free tier OK | ✅ free | ✗ |

---

## 5. Minimum single-machine setup (getting started)

One Mac handles everything — useful for local development or a small contributor lab:

| Requirement | Notes |
|---|---|
| macOS 13+ | Ventura or later |
| 16 GB RAM | Backend + MongoDB + 2–3 simulators + Appium servers |
| Node.js 20 LTS | |
| Docker (optional) | For the `docker compose up` path; or run services directly |
| Xcode (free) + Xcode CLI Tools | Simulator runtimes, xcrun, simctl |
| Android SDK Platform Tools | If any Android devices/emulators are also on this machine |
| ADB | Bundled with Platform Tools |
| Appium 2.x | `npm install -g appium` |
| Appium drivers | `uiautomator2` for Android, `xcuitest` for iOS |
| Java 17 (Temurin) | Required by Appium |

---

## 6. Network requirements

- Agent hosts must be able to reach the central MongoDB (TCP 27017) if running on separate machines
- Agent hosts must reach the backend REST API (TCP 3000) for heartbeat and device registration
- Clients (browser) must reach backend REST (TCP 3000), execution/log WS (TCP 3000), and stream WS (TCP 3001)
- No inbound ports needed on agent hosts — agents phone home to the central backend, not the other way around

For air-gapped environments: all three services (backend, MongoDB, frontend) can be co-located on a private network. No external network access is required after initial install.

---

## 7. Known constraints and rough edges

| Constraint | Detail |
|---|---|
| iOS requires a Mac — no exceptions | Apple's signing and device communication toolchain does not run on Linux or Windows |
| iOS 17+ changed device communication protocol | Requires Xcode 15+ and macOS 13+ — older Xcode/macOS combinations cannot communicate with iOS 17+ physical devices |
| iOS simulator cap: 8 concurrent streams | xcrun drops frames silently beyond this; enforced as a hard cap in StreamingService |
| Physical iOS device WDA signing | Free Apple Developer account works but requires manual provisioning setup; automation is only partially documented by Apple |
| Android emulators on Linux require KVM | `sudo apt install qemu-kvm` + add user to `kvm` group; without KVM, emulators run in software mode (very slow) |
| USB hub quality matters | Cheap passive hubs cause intermittent ADB disconnects at 4+ devices; use powered hubs with dedicated chipsets |
| Appium 2.x plugin isolation | Conflicting Appium plugins cannot share a single Appium server instance; Mobile Hub spawns one Appium server per device to avoid plugin conflicts |
