# Mobile Hub — Project Guide

Open-source mobile device testing & automation platform for the community. Think: shared device lab + Appium-driven execution + live device streaming + results dashboard — rebuilt from the ground up, without the known gaps of prior proprietary tools (see "Lessons carried in" below).

**Status:** implementation in progress. `frontend/` and `backend/` have real, growing source trees. Don't assume what's built or working from memory — check `docs/TODO.md` first, it's the live checklist (see "Progress tracking" below).

## Repo layout

```
mobile-hub/
  frontend/     React app — see frontend/CLAUDE.md
  backend/      Node.js API + services — see backend/CLAUDE.md
  docs/         architecture blueprint, roadmap, ADRs, TODO.md, LESSONS.md, SELF_REVIEW.md
  CLAUDE.md     you are here — cross-cutting rules only, the only markdown file at repo root
```

This file covers rules that apply across the whole repo. Stack-specific commands, conventions, and gotchas live in the sub-package CLAUDE.md files — don't duplicate them here, and don't let this file grow past ~150 lines. When a rule only matters in one package, it belongs in that package's file. **Only `CLAUDE.md` lives at repo root** — every other markdown doc (checklist, lessons, self-review, ADRs, specs) belongs under `docs/`, referenced from here, not scattered at top level.

## Progress tracking

`docs/TODO.md` is the live build checklist — one row per module/feature, with a status (not started / built / tested) and a one-line note. It is the source of truth for "what actually works right now," not this file and not memory of past sessions.

- **Update it whenever you finish a unit of work**: after scaffolding a module, after a typecheck/lint pass, after a smoke test — move the row to the right status and note what was actually verified (not just written).
- "Tested" means you ran it — typecheck/lint passing is "built," not "tested." Booting the server and hitting the endpoint (or an equivalent real check) is what earns "tested."
- If you discover a checklist row is stale (marked tested but no longer works, or vice versa), fix the row as part of your change — don't leave it misleading the next session.

## Self-review

At every major completion (finishing a module, closing out a significant chunk of work, or before ending a session), run through `docs/SELF_REVIEW.md` — a short checklist covering drift from stated architecture/rules, whether "tested" claims are actually earned, whether anything discovered this session is worth promoting into a `CLAUDE.md` rule, and whether any mistake needs an entry in `docs/LESSONS.md`.

- `docs/LESSONS.md` is the running log of real mistakes made in this repo and the rule that came out of each one — retrospective and specific, not a general best-practices list (that's "Lessons carried in" below).
- Don't skip the self-review because the change felt small — the checklist itself is fast; it's what it catches that matters.

## Think before coding

State assumptions explicitly before implementing anything non-trivial. If a request has more than one reasonable interpretation, say what the interpretations are and pick one (or ask) — don't silently guess. For genuinely trivial changes (typo fix, rename, one-line bugfix), just do it.

## Simplicity first

Ship the minimum code that solves the stated problem. No speculative abstractions, no config knobs for hypothetical future needs, no "while I'm here" refactors bundled into unrelated changes. Three similar lines beats a premature helper.

## Cost & context discipline

Global policy lives in `~/.claude/CLAUDE.md` + `~/.claude/COST_OPTIMIZATION.md` and already applies here — not repeated. One thing specific to this repo: its test/E2E output is genuinely verbose (Vitest, Playwright, Mongo/server boot logs) — grep/tail it or hand a full E2E run to a subagent rather than letting the raw log sit in context, and reach for a targeted spec over the full suite while debugging one failure.

## Config-driven, organisation-aware

Mobile Hub adapts to each organisation's conventions rather than forcing its own. Key principle: **the platform is configurable, not prescriptive.**

- `mobilehub.org.yaml` (org-wide defaults) + `mobilehub.project.yaml` (per-project overrides) are the human-editable surface. The platform merges and validates them at runtime via `ConfigService`.
- Feature modules (builds, execution, analytics, streaming) can be toggled per org — some orgs bring their own build pipeline and disable the built-in one.
- Build sources (Nexus, S3, direct URL, custom webhook) are adapters behind a `BuildProvider` interface — adding a new provider doesn't touch the rest of the system.
- Automation repo structure (framework, config file path, env file, test dir) is declared in config — the platform doesn't assume a fixed layout.
- Full design is in `docs/architecture-blueprint.md §11`.

## Do this, not that

- **Do** keep frontend and backend independently runnable and independently deployable. **Not** a single monolith process.
- **Do** put device/session state behind the backend's service layer. **Not** direct DB access from route controllers.
- **Do** treat `machineId` (or whatever we call the per-host isolation key once decided) as a first-class field on any multi-host state. **Not** an afterthought bolted on later — the reference architecture's biggest late-stage pain was retrofitting host isolation.
- **Do** ask before adding a new top-level dependency to either package. **Not** pull in a library for something 20 lines of code covers.

## Lessons carried in from the reference architecture

These are gaps observed in prior proprietary tools in this domain that Mobile Hub should design around from day one, not patch later:
- Streaming capacity: 1 device stream ≠ 1 viewer capacity for some protocols. Decide multi-viewer fan-out (shared capture + N viewers) up front, don't assume 1:1.
- Multi-host / multi-machine isolation must be a schema-level concern from the first model, not a migration.
- Zip/artifact download integrity needs validation before "done", not after a support ticket.
- Auth/RBAC should be scoped in the initial design even if v1 ships with a minimal implementation — retrofitting roles later touches every controller.

Full architecture decisions and rationale go in `docs/architecture-blueprint.md` (or equivalent) once planning is finalized — treat this list as input to that doc, not a substitute for it.

## Contribution norms (open source)

- Every non-trivial change should be explainable in a PR description without needing to read the whole diff.
- Public API/route changes need a note in the PR — contributors and downstream users won't have session context.
- Prefer clear code over clever code; this is a community project, optimize for the next contributor's ability to onboard, not for the fewest keystrokes.

## Recommended Claude Skills (project-wide)

Package-specific skill shortlists live in `frontend/CLAUDE.md` (design/React/a11y) and `backend/CLAUDE.md` (security/supply-chain). These are the general-purpose ones worth having regardless of which package a session is touching:

- [anthropics/skills](https://github.com/anthropics/skills) — the official Anthropic marketplace. Install via `/plugin install example-skills@anthropic-agent-skills` and `/plugin install document-skills@anthropic-agent-skills`. Authoritative reference implementation; safe default to add to.
- [trailofbits/skills](https://github.com/trailofbits/skills) — security-firm-maintained, covers both frontend and backend concerns (see backend/CLAUDE.md for the specific skills pulled from here).

None of these are installed in this repo yet. When picking skills from generic "best Claude skills" roundup articles/sites (there are many low-accountability listicle/SEO sites in this space — e.g. skills-hub.ai, aiskill.market, mcpmarket.com, claudemarketplaces.com), verify who maintains the actual skill before installing: a skill is instructions the agent follows, so an unvetted one is a real supply-chain risk, not just a curiosity.

## Locked decisions

- Package manager: **npm**
- Backend framework: **Fastify**
- DB: **MongoDB** (Mongoose)
- License: **MIT**

Full rationale and the resulting schema/service design are in `docs/architecture-blueprint.md`.
