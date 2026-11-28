# Agent workflow: device setup analysis

You are analysing how this project's mobile test devices are prepared, warmed up and run, and writing one HTML report. Follow the steps in order. Read the referenced kit files when a step names them. Do not skip the questions step.

## 0. Ground rules (apply throughout)

1. **Read-only.** Do not boot, shut down, erase, create, clone or delete devices. Do not install, uninstall or upgrade packages, drivers, SDK parts or apps. Do not change settings on devices or hosts. Do not edit project files except to write the report and the answers record (step 6).
   - Exception: an optional measurement from `PROBES.md` §7. Describe it first (what it boots, how long, what it leaves behind) and run it only after a clear yes for that measurement.
2. **Offline.** Make no network requests: no `curl`, `wget`, `npm view`, `pip download`, `git fetch`, `sdkmanager --list`, `xcodebuild -downloadPlatform`, web search, or anything else that leaves the machine. When you need a version or compatibility fact, read it from files already on disk (see `knowledge/dependencies-offline.md` §4).
3. **No secrets.**
   - Do not open `.env*`, `*.pem`, `*.key`, `*.p12`, `*.jks`, `*.keystore`, `*.mobileprovision`, `.npmrc`, `.yarnrc*`, `pip.conf`, Maven `settings.xml`, `init.gradle`, cloud credential files, or anything named like a credential. Record only that the file exists.
   - When a capability or config value looks like a credential (key, token, secret, password, user, auth, cookie, session), write `[redacted]`.
4. **No raw emulator logs.** Never read, tail or copy Android emulator console output or crash-reporter files. They can contain the full process environment. Use `adb shell` queries instead.
5. **No vendor or company names from this kit's origin.** The report talks only about the target project and generic tools.
6. **Evidence.** Every finding cites where it came from: `file:line`, a command name, or "answer to Q<n>". If something could not be checked, say so. Do not guess.

## 1. Understand the project (about 10 minutes of reading)

Read, in this order. Skip what does not exist.

1. The README, CONTRIBUTING and any agent guide in the repo root and the test folder.
2. Package manifests and lockfiles, for presence and versions only:
   - `package.json`, `requirements*.txt`, `pyproject.toml`, `Pipfile`, `pom.xml`, `build.gradle(.kts)`, `Gemfile`, `Podfile`, `pubspec.yaml`;
   - lockfiles: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`, `Gemfile.lock`, `Podfile.lock`.
3. Test runner config:
   - `wdio.conf.*`, `.detoxrc*`, `.maestro/`, `pytest.ini` / `conftest.py`, `testng.xml`;
   - `*.robot` files, `capabilities*.json`, any `caps` / `capabilities` / `config` folder.
4. Capability builders. Follow imports from the runner config to the code that builds capabilities. Values often come from maps or env variables, for example `PLATFORM_NAME[platform]`. Resolve them by reading the map, not by running code.
5. Scripts that start or prepare devices. Search for:
   - `emulator -avd`, `emulator @`, `-wipe-data`, `-no-snapshot`, `-read-only`, `-no-window`, `sys.boot_completed`;
   - `simctl boot|bootstatus|erase|clone|create|shutdown`;
   - `xcodebuild build-for-testing|test-without-building`, `build-wda`;
   - `settings put global`, `pm disable`, `launchctl`.
6. CI definitions:
   - `.github/workflows/*`, `.gitlab-ci.yml`, `Jenkinsfile*`, `azure-pipelines*.yml`, `bitrise.yml`, `codemagic.yaml`, `.circleci/config.yml`, `.buildkite/`, `fastlane/Fastfile`;
   - note the runner OS, whether device tests run in CI at all, caching, and every step that downloads something.

Write down (for the report's "Project understanding" section):

- the framework(s) and language;
- the platforms covered;
- where capabilities are defined;
- how a device is chosen (fixed UDID, AVD name, cloud provider, allocator);
- how the app gets onto the device (`app` capability, preinstalled, a fetch script);
- the reset strategy (`noReset` / `fullReset` / explicit clear);
- the parallelism setting (`maxInstances`, workers, shards);
- what CI runs.

## 2. Ask the questions

Open `QUESTIONS.md`.

- For each question, try to infer the answer from step 1 first.
- Ask the user only what you could not infer with confidence. Put all of it in **one message**, at most 6 questions.
- For each inferred answer, state it in one line so the user can correct it.

Wait for the reply before step 3. If the user does not answer a question, use the default given in `QUESTIONS.md`, and mark it "default" in the report.

## 3. Probe the host (read-only)

Open `PROBES.md`. Run the sections that apply to this OS and to the platforms in scope:

- §1 host;
- §2 tools and versions;
- §3 Android SDK and AVDs;
- §4 running Android devices;
- §5 Xcode and simulators (macOS only);
- §6 WebDriverAgent and Appium drivers.

Rules:

- Use the timeouts given there.
- If a tool is missing, record "not installed" and move on.
- Probe at most 6 running devices.
- Keep only the extracted facts listed for each command. Do not paste whole outputs into the report.

When iOS is in scope but this host is not macOS, say so. List the capability-level iOS checks you can still do, and recommend re-running the kit on the macOS host.

## 4. Analyse

Open `CHECKS.md` and evaluate every check whose platform is in scope:

- **Triggered:** record a finding with its ID, severity, evidence, fix (adapted to this project's files and framework), risk and phase.
- **Explicitly passed:** note it for the "What is already good" list. The report should credit good setup, not only list gaps.

Then add project-specific findings that the catalogue does not cover. Use the same shape and the ID prefix `PRJ-`. Use `knowledge/*.md` for the reasoning, especially:

- pre-warm strategy: `knowledge/android.md` §2–§4 and `knowledge/ios.md` §2–§4;
- WebDriverAgent warm-up: `knowledge/ios.md` §5–§6;
- device capabilities you can use instead of UI steps (permissions, locale, location, deep links): the "capabilities" sections of both platform files;
- dependency and offline sourcing: `knowledge/dependencies-offline.md`;
- risks of each change: `knowledge/risks.md`.

Estimate per-host capacity with `CHECKS.md` §"Capacity estimate". Label it as an estimate to confirm in phase P0.

## 5. Plan and tailor

Build the action plan with the phases in `CHECKS.md` §"Phases":

- **P0** baseline and unblock;
- **P1** zero-risk warm-up wins;
- **P2** lean images and golden devices;
- **P3** slim profiles;
- **P4** parallel capacity;
- **P5** CI.

Each item says what to change, in which file of this project, the exact command or config, how to verify it, and how to roll it back.

Tailored solutions must be concrete for this project:

- use its real AVD names, simulator types, runtimes, capability file paths, framework syntax (WebdriverIO config, Java `setCapability`, Python options, and so on), worker count and CI system;
- take snippets from `knowledge/*.md` and rewrite them for the project. Do not paste generic placeholders where the real value is known;
- every source you name must be reachable offline (`knowledge/dependencies-offline.md` §2).

## 6. Write the outputs

1. `device-setup-report.html` in the project root, exactly as `REPORT-SPEC.md` describes: one self-contained file, no external assets, no scripts that fetch anything.
2. `device-setup-answers.md` in the project root: the answers record from `QUESTIONS.md` §"Answers record", filled in. A later run on another host reads it and skips the questions.

Before you finish, check the report:

- every section in `REPORT-SPEC.md` is present;
- every finding has evidence;
- no secret values;
- no network-loaded assets: search the file for `http://` and `https://`. Allowed only as plain text inside a finding that names a blocked URL;
- it opens as a local file.

## 7. Hand-off message

Reply to the user in at most 12 lines:

- the report path;
- the verdict sentence;
- counts by severity;
- the top 3 actions;
- anything you could not check and why;
- any measurement from `PROBES.md` §7 you recommend running next, with what it would do.
