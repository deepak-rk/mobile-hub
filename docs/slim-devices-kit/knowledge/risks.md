# Risks, governance, verification, rollback

## 1. Risk register (put the applicable rows in the report)

| # | Risk | Likelihood | Impact | Control |
|---|---|---|---|---|
| R1 | **False green:** a slimmed or lean device hides a bug that a stock device shows | Medium | High | Keep a stock control device in every run. Slim only what Q6 says the app does not use. Compare slim and stock results over 3 full runs before adopting (P3 exit). |
| R2 | A disabled package/daemon breaks an intent, permission dialog, web view or push flow | Medium | Medium | Allow-list (not block-list). Never touch the protected lists in `android.md` §7 and `ios.md` §8. Verify after apply. One-command rollback. |
| R3 | Stale warm state: snapshot, golden simulator or prebuilt WDA from an older image/Xcode/driver | High over time | Medium | Key every cached artifact on the versions that invalidate it; rebuild on mismatch. Store a `.meta` note beside it. |
| R4 | Supply chain: tools or scripts from outside the mirror, or unpinned versions | Medium | High | `dependencies-offline.md` §5. |
| R5 | Port or derived-data collisions in parallel runs cause random session failures | High when parallel | Medium | Port table per worker (`capabilities.md`). One derived data folder per simulator. |
| R6 | Host overcommit: too many devices, causing swap and timeouts that look like app bugs | Medium | Medium | Capacity estimate, then measured density in P4. Watch swap and memory pressure during runs. |
| R7 | Secrets in logs: emulator crash reporters and verbose xcodebuild/Appium logs can include environment variables and paths | Medium | High | Never attach raw emulator console output or `showXcodeLog` output to tickets or CI artifacts. Use structured Appium logs at `info` level. |
| R8 | Licence terms: Google system images and macOS virtualisation carry terms (for example limits on macOS VMs per host) | Low | Medium | Have the owner confirm the terms before scaling hosts or images. |
| R9 | Snapshot restore leaves the clock, network or locale in a stale state | Medium | Low | Set `auto_time`, check network after boot, and set locale by capability per session. |
| R10 | Rollback missing or untested | Medium | High | Every P3 change ships with a tested rollback command and the previous value recorded. |

## 2. Control group rule

In every run that uses slim or lean devices, at least one worker runs on a stock device of the same OS version. A test that passes on slim but fails on stock is a P3 regression. Roll back the profile until the cause is known.

## 3. Third-party slimming tools

Tools exist that disable simulator daemons or emulator packages in bulk. Before adopting one:

1. **Source:** it must come from the internal mirror at a pinned version, with a checksum. No install from public GitHub at run time.
2. **Review:** read what it changes, line by line. It acts on system services. Map each change to an equivalent vendor command in `android.md` §7 / `ios.md` §8.
3. **Reversibility:** it must have a documented, tested undo.
4. **Scope:** it may run only on test devices, never on hosts or personal devices.
5. **Exit:** if the vendor-command equivalent is short, prefer that and skip the tool.

## 4. Governance for slim profiles

- **Profile file:** a profile is a versioned file in the test repo (`slim-profile.android.txt`, `slim-profile.ios.txt`). Each entry has a reason and the app need it was checked against.
- **Review:** a change to a profile is reviewed like code, by someone who knows the app's features.
- **Run records:** each test run records which profile, if any, was on each device, so failures can be correlated.
- **Exception:** a run that sets a "stock only" flag must run with no profile, for release sign-off.

## 5. Verification checklist (after any P1–P4 change)

- [ ] Devices reach ready (`sys.boot_completed=1` / `bootstatus`) every time over 5 boots.
- [ ] Session start time is lower than the P0 baseline.
- [ ] The full suite passes as before on 3 consecutive runs; no new flaky tests.
- [ ] The stock control device gives the same results.
- [ ] Rollback was executed once and returned the device to its previous state.
- [ ] The cache/snapshot `.meta` matches current versions.
