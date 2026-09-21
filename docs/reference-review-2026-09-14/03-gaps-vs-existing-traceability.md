# Mapping onto `docs/SOURCE_FEATURE_TRACEABILITY.md`

What this review confirms about existing rows, what it suggests changing, and what's genuinely new and not yet tracked at all. Nothing in this file has been applied to the live traceability doc yet — recommendations only.

---

## Confirms existing dispositions (no change needed, just corroborating evidence)

- **"`BuildProvider.listBuilds()`", "Build provenance", "Changelog", "Contributors"** (Builds section, all REIMPLEMENT/ADAPT) — all present and working in the comparison system. Confirms these are real, worth building, correctly not yet built.
- **"Squad/team breakdown", "App icons on cards", org-specific filename parsing** (Builds section, all DROP for v1) — all present in the comparison system but correctly out of scope here: organisation-specific, no config-driven path exists yet. No change recommended.
- **"`adb` runs beside the device, on the agent"** (Streaming section, REIMPLEMENT, "Largest architecture gap") — confirmed as accurate, and now confirmed to also apply to execution/Appium (see below — this changes the framing, not the correctness of the original row).

## Recommend changing

### Host operational diagnostics
Current: marked **DONE** as of 2026-09-14 (disk free/total, Node version, live activity counts).

This review found the comparison system's equivalent job is broader: CPU%, RAM used/total, network throughput, a heartbeat history visualization, per-agent capability/version display, an agent-version-drift indicator, the hub itself as a monitored row, and a deregister/remove-agent action. Recommend the existing DONE row be annotated to name the actual subset it covers, with the remainder split out as a new REIMPLEMENT row — so "DONE" doesn't read as the whole job being finished when only a scoped piece shipped. (See `01-architecture-findings.md` §4 for the CPU/RAM measurement gotcha to check before that row is ever attempted.)

### Entity / tag as real run inputs
Current: **REIMPLEMENT**, noted as downstream of `SuiteProvider`, with an earlier open question in this session about whether "Entity" adds anything beyond what suite/tag already cover.

This review resolves that ambiguity with concrete grounding from the comparison material: **Entity** and **Tag** are genuinely distinct, both real inputs. Entity is a configurable, per-organisation identity/brand axis — which of an org's several declared apps or configurations a run or build targets (mobile-hub's own config-driven, multi-project design already has the right shape for this; it just isn't wired into execution's run inputs yet). Tag is a test-framework-level filter (e.g. a Cucumber tag) applied within a suite. Neither is redundant with the other or with suite. Recommend removing the "is this even needed" ambiguity note and replacing it with this concrete definition.

### Real queue + backoff when the device is busy
Current: **ADAPT or rename** — "there is no queue... either build the queue or stop using the word."

This review found direct, working evidence in the comparison material that a real, visible queue (explicit position, a "waiting for `<criteria>`" reason, a cancel action on a queued item) is a genuine, validated, shipped feature elsewhere — not merely a naming question. Recommend upgrading the disposition to **REIMPLEMENT** with the concrete shape from `02-ui-ux-patterns.md`, rather than resolving the ambiguity by dropping the word "queue."

### Streaming capture locality
Current: **REIMPLEMENT**, "Largest architecture gap," scoped to streaming only.

This review found (and verified against mobile-hub's own code — see `01-architecture-findings.md` §1.3) that the identical locality problem applies to **execution/Appium orchestration**, which is more central to the product's purpose than streaming. Recommend this become one combined initiative (a shared "agent runs a local process for a device, reports back a reachable endpoint" primitive, used for both streaming and execution) rather than two separate efforts — see the architecture findings file for the recommended fix shape and a safe validation path that doesn't require real second hardware.

## Recommend changing (additional, from a second verification pass)

### Real flakiness (stddev of daily pass rate)
Current: **DONE**.

Still accurate for what it covers — but this review found the underlying capability has three distinct granularities (see `02-ui-ux-patterns.md`'s Analytics section), of which only the coarsest (suite-level) is built. Recommend annotating the DONE row to name that scope explicitly, with the other two tracked as new rows below, so "DONE" doesn't read as "flakiness detection, solved."

## Genuinely new — not currently in the traceability doc at all

- **Agent-side download integrity gate** (`01-architecture-findings.md` §1.4, verified against `hub-client.ts`/`installer.ts`) — a real, confirmed asymmetry: the hub's own fetch from a `BuildProvider` has a real integrity gate; the agent's fetch of the same artifact from the hub does not. Recommend a new row under Device install, likely a small, well-scoped, independent fix (temp-file + atomic rename + final-size assertion, mirroring the pattern the hub-side fetch already uses).
- **Execution stage model omits post-execution/release as visible stages, and orphan recovery doesn't close the Appium session it may have opened** (`01-architecture-findings.md` §1.5, verified against `execution-run.model.ts`/`execution.service.ts`) — recommend a new row under Execution; natural companion work to whatever eventually builds the agent-side Appium module for §1.3, not necessarily separate work.
- **Config-tuple-level and test-case-level flakiness** (`02-ui-ux-patterns.md`, two of the three granularities) — recommend two new rows, distinct from the existing DONE suite-level row, not folded into it.
- **Device utilisation as an analytics dimension** (`02-ui-ux-patterns.md`) — recommend a new row under Analytics.
- **Device identity / lock scoping gap** (`01-architecture-findings.md` §1.1, §1.2) — a confirmed bug, not merely a gap. Recommend a new row once a fix approach (A/B/C in that file) is chosen; this is a correctness bug, not a missing feature, so it likely deserves placement near the top of whatever priority ordering the doc uses once decided.
- **Agent-side build caching + direct-agent-to-source build downloads** (`01-architecture-findings.md` §3) — recommend new rows under the Builds section, described in fully generic terms (no specific artifact-repository product implied), since the underlying pattern is provider-agnostic.
- **Generic OS-level device permission granting during install** — distinct from the already-correctly-DROP'd "post-install GUI env setup via hardcoded taps" row. The comparison material's permission-granting step uses generic OS mechanisms (platform-level privacy/permission grant APIs), not organisation-specific UI automation — worth a fresh, separate row rather than folding it into the already-dropped hardcoded-tap-sequence item, since it's a different kind of thing with a much better risk/value ratio. Not yet recommended for a disposition — see `04-open-questions-and-next-steps.md` for why this needs a decision first, not just a row.
- **Live device view embedded on the run-detail page** (`02-ui-ux-patterns.md`) — bridges the Execution and Streaming sections; not currently tracked under either.
- **Build compatibility constraints as a first-class field** (`02-ui-ux-patterns.md`) — small, not currently tracked.
