# Slim virtual devices: enterprise adoption plan

Status: plan, 2026-11-28. It is generic and applies to any organisation that runs a shared mobile device lab or CI fleet, including one built on Mobile Hub. The companion file `feasibility.md` covers the open-source project itself; the designs for our own versions are in `architecture-mobile-hub.md` and `architecture-any-organisation.md`. The iOS tool is [simslim](https://github.com/MobAI-App/simslim) (MIT, Go; reviewed directly in the companion file, §3a); the Android tool is referred to generically.

## 1. The enterprise question

Slimming virtual devices promises 3–5 times more simulators or emulators per machine, and near-zero idle CPU. For an enterprise the question is less "does it work" and more these four:

- Can we run it under our supply-chain, change-control and audit rules?
- Does it make our test results less trustworthy?
- Who owns it when an OS update breaks it?
- Is the hardware saving worth that ownership?

## 2. Verdict

| Approach | Enterprise verdict | Reason |
|---|---|---|
| Install the third-party tools on developer laptops and CI runners as-is (brew tap, `go install @latest`, third-party CI actions) | **Not recommended** | Unpinned binaries fetched from public hosts. The Android tool's SDK shim modifies developer tooling silently. Behaviour changes with every OS release. Most security reviews would reject installs that are neither pinned nor reviewed. |
| Pin, mirror and review the tools (internal fork, signed internal build) | **Possible, costly** | The organisation now owns a fork of code that tracks undocumented OS internals. It needs a named owner and a retest on every OS release. |
| simslim on **lab-managed** Macs for the inner-loop iOS tier: built from a pinned commit through the internal Go proxy, `on`/`off` only, no `watch` or `disk-clean`, stamped on every run | **Recommended for a pilot** | It only changes per-simulator state (the Mac is untouched), it is MIT, and it can be undone. Reimplementing it would mean owning the same undocumented internals. It needs a named owner who retests it on every Xcode release; it never gates a release. |
| Reimplement the safe subset in the lab platform (opt-in Android slim profile via `adb`, recorded on every run) | **Recommended** | It uses only first-party vendor tools (`adb`, and `xcrun simctl` later). It is reviewable and small, it reverses cleanly, and it is audited through the platform. |
| Tiered testing (slim / stock / physical) as policy | **Recommended** | It keeps release decisions on stock and physical devices while the inner loop gets faster. |

## 3. Security review

| Concern | Detail | Control |
|---|---|---|
| Code provenance | Binaries from a public source-code host, CI actions resolved at run time | No third-party binaries. The platform's own code, reviewed through normal change control. |
| Host modification | The SDK binary shim rewrites how `emulator` runs for every user of that host | Forbidden. The platform never edits tools it does not own. |
| Device modification | Package disable and settings changes on devices | Emulators only by default. Physical devices need an explicit organisation setting and role. Every change is logged and reversible. |
| Privilege | Pruning iOS daemons touches simulator runtime overrides | Deferred. If adopted later, it runs only through the vendor's `simctl`, on lab-managed Macs and never on personal ones. |
| Data | Neither approach needs network access or sends data | Confirm with egress monitoring during the pilot. |
| Process spawning | Managed emulator lifecycle (later phase) means the agent starts processes | Bounded and allow-listed arguments, no shell strings, cleanup on agent exit (the existing single-instance and cleanup rules). |

## 4. Supply-chain policy

1. **No git or source-host dependencies in production builds.** They have no lockfile integrity hash, cannot go through registry mirrors, and fail behind proxies that block git or SSH. Every internal package goes to an internal registry (or the public registry with provenance) and is consumed by version.
2. **Internal mirror for everything.** npm registry proxy; container registry proxy for base images (`node`, `mongo`); an internal mirror for the Android SDK and system images; an internal copy of Appium drivers.
3. **Pin and verify.** Lockfiles committed. `npm ci` only. Integrity hashes present for every entry, with CI failing when one is missing. Container images pinned by digest.
4. **Install scripts.** Allow-list the packages that need one (native addons such as image or hashing libraries). Run everything else with `--ignore-scripts` in CI.
5. **SBOM** per release (CycloneDX or SPDX) with licence scan. simslim is MIT; its CLI brings 20 Go modules into the SBOM. Confirm the Android tool's licence before reusing its curated package list verbatim.
6. **CI actions.** Internal or vendor-maintained only, pinned by commit SHA. No third-party actions that fetch tools at run time.

## 5. Offline and air-gapped installs

- **The platform:** an offline bundle containing the npm tarballs (`npm pack` of every dependency, or a pre-populated registry snapshot), container images saved as archives, and a checksum manifest.
- **Android:** the SDK packages and system images come from an internal mirror (`sdkmanager --channel` plus an internal repository URL). The slim profile ships inside the platform's config, so it needs no download.
- **Snapshots (later phase):** golden snapshots are built inside the network and treated as artifacts. They are checksummed and versioned per system image and per profile, and are never pulled from outside.

## 6. Licensing

- The platform is MIT (permissive). Internal forks and extensions are allowed; keep notices.
- Native and image libraries carry their own licences (for example Apache-2.0). Include them in the SBOM.
- Android system images and Xcode simulator runtimes are under vendor terms, which may limit redistribution and the use of runtimes on non-vendor hardware. Check before building shared snapshot artifacts or running simulators on virtualised Macs.

## 7. Identity, access and audit

| Capability | Requirement |
|---|---|
| SSO | OIDC or SAML login in front of the platform. Map groups to roles: viewer, operator, admin. |
| RBAC | Apply or remove a profile: operator, and only while holding the device lock. Allow profiles on physical devices, or change the package list: admin. |
| Audit | Every profile change is an audit event recording who, when, which device, which items, and the read-back result. Runs store the active profile and manifest as evidence. Audit is append-only and cannot be turned off by the actor. |
| Machine identity | Lab hosts use a stable, persisted identity. Two machines claiming one identity are refused (already built in Mobile Hub). |
| Credentials | Per-host agent credentials, revocable. Hosts removed from the lab stay removed (already built). |

## 8. Test-result integrity (the quality risk)

- **The policy is tiered:** Tier 1 (slim) for the inner loop and AI-agent loops; Tier 2 (stock virtual devices) gates merge; Tier 3 (physical devices) gates release.
- **Each run stores its tier.** Dashboards split pass rates by tier, and a release report counts only Tier 2 and Tier 3.
- **A known-impact list per profile** covers push, deep or universal links, in-app purchase, background sync, location and Bluetooth. Suites tagged with these areas are routed to stock devices automatically.
- **Low-RAM guests are never the default.** They are allowed only for deliberate low-end device testing and labelled as such.

## 9. Scaling and capacity

- **Measure before buying.** Take the per-host density baseline (RAM per emulator, idle CPU, boot time) before and after the slim profile, on the organisation's own images. The analysis's numbers assume uncapped stock images. Labs that already cap guest RAM will see smaller gains.
- **Capacity model:** devices per host = (host RAM − platform reserve) ÷ measured RAM per device, capped by CPU and the GPU path in use. Track it in the fleet view.
- **Golden snapshots (later)** turn cold boots of tens of seconds into seconds, and give a clean state per run. That matters more for flaky-test rates than for density.

## 10. Support and operations

| Item | Owner and practice |
|---|---|
| Package and profile list | A named owner. Retest on every new Android API level before it is allowed on that level. Keep a per-level list. |
| OS release changes | Canary hosts get new system images first. The profile is applied, boot is checked, and a smoke suite runs. Then promote. |
| Rollback | One action per device (`remove profile`). Automatic rollback if boot does not complete after applying. |
| Incidents | A run page shows the profile, so triage starts with "slim or stock?" Re-run on stock in one click. |
| Monitoring | Per-host RAM and CPU, profile coverage, slim-only failure rate. |

## 11. Rollout phases

| Phase | Scope | Exit criteria |
|---|---|---|
| 0. Baseline | Measure current density and idle CPU on 2–3 representative hosts | Numbers agreed; target set |
| 1. Supply-chain clean-up | Remove git dependencies; mirror registry, images and SDK; SBOM in CI; pin actions by SHA | Offline install succeeds from mirrors alone |
| 2. Pilot | Slim profile on emulators of one team, Tier 1 only, read-back and audit on | Two weeks with no unexplained slim-only failures; measured saving is at least the target |
| 3. Policy | Tier routing (impact-area tags go to stock), dashboards split by tier | Release reports count Tier 2 and 3 only |
| 4. Scale | All lab hosts; capacity model in the fleet view | Density target met fleet-wide |
| 5. Snapshots (optional) | Managed emulator lifecycle, golden snapshots as internal artifacts | Per-run clean start in seconds; corrupt-snapshot fallback proven |
| 6. iOS (optional) | Only after the platform supports iOS simulators through vendor tools | Same controls as Android |

## 12. Cost and effort (rough, one experienced engineer)

| Work | Effort |
|---|---|
| Baseline measurement | 1–2 days |
| Remove git dependencies; mirrors; SBOM; action pinning | 3–5 days (more if no internal registry exists yet) |
| Android slim profile as a device-config job, with read-back, audit and tests | 1–2 weeks |
| Tier stamping, routing and dashboards | 1 week |
| Managed emulators and golden snapshots | 3–5 weeks |
| Ongoing: per-OS-release list maintenance | About 1–2 days per Android API level |

**Benefit to weigh against this:** fewer hosts for the same parallel capacity, and faster inner-loop feedback. Weigh against it the standing maintenance cost of the package list, and the risk of slim-only false results if the tier policy is not enforced.

## 13. Decisions an adopting organisation must make

1. Is an internal registry and mirror available, or is it part of this work?
2. Are physical devices ever eligible for a slim profile?
3. Who owns the package list per OS release?
4. Is managed emulator lifecycle (snapshots) worth its 3–5 weeks, or is density alone enough?
5. Which test areas must always run on stock devices (the routing tag list)?
