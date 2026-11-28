# Slim virtual devices

Running more Android emulators and iOS simulators per machine by switching off background services they do not need for testing. **Design and analysis only.** Nothing here is built or scheduled, and it is kept independent of the main plan (`docs/reconciliation-plan-2026-11.md`) until a decision is made.

| File | What it is |
|---|---|
| `feasibility.md` | Analysis of the public tools (including [simslim](https://github.com/MobAI-App/simslim)): advantages, disadvantages, risks, verdicts, dependency inventory, open questions |
| `enterprise-adoption-plan.md` | Policy view for any organisation: security review, supply chain, offline installs, licensing, audit, rollout, cost |
| `architecture-mobile-hub.md` | Design of our own version **inside Mobile Hub**: profiles in org config, device jobs, manifest, gates, rollback, drift, run stamping, tiers, iOS later |
| `architecture-any-organisation.md` | Design of a **self-owned standalone tool** for any organisation (with or without Mobile Hub): CLI, policy files, audit log, CI integration, governance, rollout |

**Verdict in one line:** take the ideas, build a small version on vendor tools (`adb`, `xcrun simctl`) with read-back, rollback and a profile stamp on every run; never gate a release on slim devices.

**Decisions needed before any build:**

1. Measure first (phase S0 / R0)?
2. Is the agent starting and stopping emulators (managed emulators) in scope?
3. Should physical devices stay excluded for good?
4. For iOS, our own `simctl`-based runner (design above), or an optional admin-installed simslim?
