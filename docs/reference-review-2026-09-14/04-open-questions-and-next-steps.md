# Open questions and recommended next steps

Decisions that need a person, not a document, before anything in this folder becomes a committed plan.

**Status update, 2026-09-21**: the two independent, no-decision-needed items are done — `appium.service.ts`'s `servers` Map now keys on `machineId:udid`, orphan/cancel recovery now closes the Appium session it may have opened (§1.2/§1.5), and the agent's download-integrity gate is built (§1.4). See `docs/SOURCE_FEATURE_TRACEABILITY.md` and `docs/TODO.md` for the verified detail.

**Second update, same day**: everything else from `02-ui-ux-patterns.md` that didn't need a decision is also now built — device utilisation, both remaining flakiness granularities, agent-side build caching, build compatibility constraints, the real execution queue, and the live device view on the run-detail page. All live-verified where the dev environment allowed (see `docs/TODO.md`'s execution/analytics/builds entries for exactly what was and wasn't). Deliberately **not** built in this pass: **Entity** as a run input (see below — reconsidered, not clearly needed given mobile-hub's `project` model) and **direct-to-agent build download** (bigger, deferred). Everything below this line is still open and still needs a decision from a person.

## Decisions needed

1. **Device identity API fix — which option?** `01-architecture-findings.md` §1.1 lays out three approaches (breaking route change, additive non-breaking disambiguator, switch to Mongo `_id`). This is a public-contract decision root `CLAUDE.md` explicitly reserves for an explicit instruction, not something to resolve unilaterally.
2. **Sequencing** — does the combined streaming+execution locality initiative (§1.3) get scheduled ahead of, alongside, or behind whatever else is currently open in `docs/SOURCE_FEATURE_TRACEABILITY.md`'s ordered plan? It's a strong candidate to move ahead of the plan's current P2 (which today only covers streaming) given execution is more central to the product, but that's a priority call, not a technical one.
3. **Is generic OS-level permission-granting during install in scope at all?** The capability itself (platform-level privacy/permission grant APIs, not organisation-specific UI taps) is real and the risk/value ratio looked reasonable in the comparison material, but it adds meaningful ongoing surface area — per-platform-version behavior differences, a genuine testing burden across OS versions — for a capability no current mobile-hub user has actually asked for yet. Worth a deliberate "do we want this" conversation rather than defaulting to REIMPLEMENT just because it's real.

## Not yet verified — flagged, not confirmed

- **Whether a double/overlapping heartbeat POST can race against mobile-hub's own compound unique index** in `hosts.service.ts`/`devices.service.ts`, the way the comparison material's own fix log described needing a retry-and-recover pattern for its equivalent code. This was flagged as a concern during the review but not actually checked against our code — worth a dedicated look before assuming either way, likely a quick, bounded piece of verification (not a rewrite) once someone has time.
- **Mobile-hub's own boot sequence** for the "accepting traffic before an in-memory cache is warm" gotcha (`01-architecture-findings.md` §4) — plausible risk at higher agent counts, not checked against `server.ts` yet.

## Recommended immediate next step, if/when this becomes active work

Fix the two confirmed, small, low-risk bugs first (§1.1's underlying key, and §1.2's `appium.service.ts` `servers` Map) once a device-identity approach is chosen for §1.1 — both are independent of the much larger execution/streaming-locality rearchitecture (§1.3) and don't need to wait for it. The bigger initiative (§1.3) is real and important but is also a genuinely larger, riskier piece of work that deserves its own dedicated planning pass, not a bolt-on to a bug fix.
