# UI/UX interaction patterns

Lower confidence than `01-architecture-findings.md` — these are candidate ideas observed in the comparison material's current app and its own proposed redesign, not verified gaps in mobile-hub. None of these are a visual style recommendation; mobile-hub's `docs/ui-guidelines.md` already made a deliberate, different aesthetic call (restrained, not a dense metrics-dashboard look). Only the underlying interaction/data pattern is worth considering, never the skin.

---

## Navigation and attention

- **Nav-level attention badges** — a small count badge on a top-nav section indicating something there currently needs attention (e.g. a count of offline/needs-attention devices on a "Devices" nav item, or a count of currently-running executions on an "Execution" nav item). Cheap, and turns "I should go check" into "the app is telling me to go check."

## Infrastructure / host diagnostics

- **Threshold-colored resource bars** — a resource metric (disk, and eventually CPU/RAM) shifts color at configurable bands (e.g. green under 70%, amber 70–90%, red above 90%) instead of a single flat color regardless of value. Small, cheap, meaningfully more scannable at a glance across many hosts.
- **The hub's own resource usage shown as a monitored row**, not hidden — once host diagnostics grow richer, the hub itself is a machine too and its own load matters, especially once it's coordinating several agents.
- **An explicit "this agent's software version is behind the rest of the fleet" indicator** — useful once more than a couple of agents exist in a real deployment; catches an agent silently missing a fix the rest of the fleet already has.

## Execution

- **A real, visible execution queue**: position in queue, an explicit "waiting for `<criteria>`" reason (e.g. waiting for any device matching a platform, or a specific device by name), and a cancel action on a queued (not yet running) item — rather than a trigger simply failing with "device busy, try again." Mobile-hub's own traceability notes already flag this exact question as unresolved ("real queue, or stop calling it one"); the comparison material's current app treats it as a real, shipped feature, which is good independent evidence it's worth building properly rather than resolving the ambiguity by renaming it away.
- **A live device view embedded directly on a run's detail/log page** while a run is in progress, not only on a separate dedicated streaming page. Ties the execution and streaming feature areas together specifically for debugging a live failure as it happens, without navigating away from the log.

## Analytics

Flakiness detection turned out to have **three genuinely different, non-overlapping granularities** worth naming separately rather than treating as one solved problem:

1. **Suite-level daily pass-rate variance** — already built in mobile-hub (`docs/SOURCE_FEATURE_TRACEABILITY.md` marks this DONE). Answers "is this suite unstable overall."
2. **Full run-configuration-tuple variance** — suite + tag + platform + branch + whatever per-organisation identity axis exists, grouped together and measured for variance as one unit. Answers "is this *specific combination* unstable," which can hide inside a suite-level number that looks fine in aggregate (one branch/platform combination flaky, the rest solid, averages out to "looks okay"). Not currently built.
3. **Individual test-case alternation across recent runs of the same configuration** — literally "did this one named test pass then fail then pass across the last N runs of the same config." The most actionable of the three, since it names the specific failing thing rather than a bucket it lives in, but requires per-test-case history, not just per-run aggregate counts. Not currently built.

These compose (2) is a grouping refinement of (1), and (3) is a different axis entirely (test identity over time, not config identity) — worth keeping distinct in any future design rather than assuming solving one subsumes the others.

- **Device utilisation as its own analytics dimension** — what fraction of the fleet's device-time is actually in use versus idle, distinct from pass-rate/duration metrics entirely. Answers a capacity-planning question ("do we need more devices") that no currently-tracked mobile-hub metric answers. Not currently built.
- **Per-device or per-agent "recent pass-rate" as a compact visual** (a short colored-dot history or sparkline) directly in a device grid or infrastructure list — for spotting a specific troublesome device at a glance, distinct from the aggregate analytics dashboard which answers a different question (fleet-wide trend, not "which one device is the problem").

## Builds

- **A build's install compatibility constraints shown as a first-class field** (minimum OS version, architecture, any feature-flag requirements) on the build list — not just its bare version number. Helps an operator pick the right build for a given device before attempting an install that's doomed to fail on an incompatibility that was knowable in advance.
