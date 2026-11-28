# Device Setup Analysis Kit

A folder of Markdown instructions. Copy it into any mobile test-automation project, point an AI coding agent at `AGENT.md`, and it will:

1. understand the project (framework, capabilities, scripts, CI, dependencies);
2. ask you a few questions it cannot answer from the files;
3. inspect the host with **read-only** commands (Android SDK/emulator/adb, Xcode/`xcrun simctl`, Appium drivers, WebDriverAgent builds);
4. analyse boot pre-warm, WebDriverAgent warm-up, emulator/simulator capabilities, dependencies, risks;
5. write one self-contained HTML report with findings, an action plan and solutions tailored to that project.

The kit contains no executable files. Every command, rule and layout the agent needs is written out in these documents.

## Built for restricted networks

The kit assumes the target machine has **no public internet or GitHub access**:

- nothing in the kit downloads anything, and the agent is told never to;
- every recommendation names an offline source: vendor SDKs already on the machine, an internal package registry, or an internal artifact store;
- any dependency or script that needs public GitHub at install or run time is reported as a blocker, with the offline replacement;
- the specs carry enough detail (flags, file paths, file formats, capability semantics) to work without looking anything up.

## Safe by default

- **Read-only.** The agent boots, erases, installs and changes nothing unless you approve that specific step. Measurements that boot a device are listed as optional and need a yes.
- **No secrets.** `.env*`, key stores, registry config (`.npmrc`, `settings.xml`, `pip.conf`) and credential-like capability values are never read or printed. Only file names are noted.
- **No log dumps.** Raw Android emulator console output can contain the full process environment. It is never read, copied or attached.
- **Report stays local.** It is written into the project folder and sent nowhere.

## Files

| File | Purpose |
|---|---|
| `AGENT.md` | The workflow the agent follows, start to finish. Start here. |
| `QUESTIONS.md` | The question bank, how to infer answers from the project, and the answers record. |
| `PROBES.md` | Every read-only command, per OS (macOS, Linux, Windows PowerShell), and what to extract. |
| `CHECKS.md` | The finding catalogue: ID, condition, severity, fix, risk, phase. |
| `REPORT-SPEC.md` | The HTML report: sections, tables, styles, and a skeleton to fill in. |
| `knowledge/android.md` | Emulator pre-warm, snapshots, lean images, AVD sizing, adb capabilities, UiAutomator2 warm-up, offline SDK. |
| `knowledge/ios.md` | Simulator pre-warm, golden simulators and clones, `simctl` capabilities, WebDriverAgent build and reuse, offline Xcode runtimes. |
| `knowledge/dependencies-offline.md` | Where every component comes from without public network access; version pinning; compatibility checks done locally. |
| `knowledge/capabilities.md` | Appium capabilities that decide boot and session-start time, with meaning, defaults and safe values. |
| `knowledge/risks.md` | Risk register, slim-profile governance, verification and rollback. |

## How to use

1. Copy this folder into the target project, for example as `device-kit/`. It does not need to be committed there.
2. In that project, ask your agent:
   > Follow `device-kit/AGENT.md` and produce the device setup report for this project.
3. Answer the questions it asks (usually 3 to 6).
4. Open `device-setup-report.html` from the project root.

To run it on two hosts, for example Windows or Linux for Android and macOS for iOS, run it on each. Give the second run the first report's answers record so the questions are not asked again.
