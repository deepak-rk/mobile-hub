# Mobile Hub — Project Guide

Open-source mobile device testing & automation platform for the community. Think: shared device lab + Appium-driven execution + live device streaming + results dashboard — an open-source sibling of proprietary tools like Leap Mobile Inspector, rebuilt without their known gaps (see "Lessons carried in" below).

**Status:** pre-implementation. Architecture is being planned before code is written. If you're picking this up mid-session and `frontend/` or `backend/` don't have real source yet, don't assume they do — check first.

## Repo layout

```
mobile-hub/
  frontend/     React app — see frontend/CLAUDE.md
  backend/      Node.js API + services — see backend/CLAUDE.md
  docs/         architecture blueprint, roadmap, ADRs
  CLAUDE.md     you are here — cross-cutting rules only
```

This file covers rules that apply across the whole repo. Stack-specific commands, conventions, and gotchas live in the sub-package CLAUDE.md files — don't duplicate them here, and don't let this file grow past ~150 lines. When a rule only matters in one package, it belongs in that package's file.

## Think before coding

State assumptions explicitly before implementing anything non-trivial. If a request has more than one reasonable interpretation, say what the interpretations are and pick one (or ask) — don't silently guess. For genuinely trivial changes (typo fix, rename, one-line bugfix), just do it.

## Simplicity first

Ship the minimum code that solves the stated problem. No speculative abstractions, no config knobs for hypothetical future needs, no "while I'm here" refactors bundled into unrelated changes. Three similar lines beats a premature helper.

## Do this, not that

- **Do** keep frontend and backend independently runnable and independently deployable. **Not** a single monolith process.
- **Do** put device/session state behind the backend's service layer. **Not** direct DB access from route controllers.
- **Do** treat `machineId` (or whatever we call the per-host isolation key once decided) as a first-class field on any multi-host state. **Not** an afterthought bolted on later — the reference architecture's biggest late-stage pain was retrofitting host isolation.
- **Do** ask before adding a new top-level dependency to either package. **Not** pull in a library for something 20 lines of code covers.

## Lessons carried in from the reference architecture

These are gaps observed in the proprietary reference (Leap Mobile Inspector) that Mobile Hub should design around from day one, not patch later:
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
