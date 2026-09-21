# Reference architecture review — 2026-09-14

## What this is

A synthesis of a deep-dive review comparing mobile-hub against a mature, real-world production implementation of the same problem domain: a self-hosted mobile device lab (device discovery, build distribution, live device streaming, Appium-driven test execution, analytics). The source material was a set of screenshots — architecture diagrams, a dated fix-log/changelog, current-app screenshots, and a proposed UI redesign — of one specific organisation's internal tool.

**This folder contains no company names, product names, brand names, entity names, people names, or internal URLs from that source material, and it never will.** Everything captured here has been deliberately translated into generic, organisation-neutral architecture and UX language. Where the source material's own scale numbers are mentioned, they appear only as an order-of-magnitude sanity check ("this needs to hold up for dozens of concurrent users and devices," not "match this exact number").

None of this is a visual style to imitate. Mobile-hub's own `docs/ui-guidelines.md` already made a deliberate, different aesthetic call (restrained, not a dense ops-dashboard look) — only functional/interaction *patterns* are captured here, never the skin.

## Why this exists

So a future session (or this one, later) doesn't have to re-derive this analysis from scratch or re-read fifty screenshots. This is reference material for planning, not a live tracker — nothing here is a commitment until it's explicitly merged into `docs/TODO.md` or `docs/SOURCE_FEATURE_TRACEABILITY.md` after a real planning conversation.

## How to use this folder

Read in this order:

1. **`01-architecture-findings.md`** — backend/architecture findings, ranked by confidence. The top section is bugs and gaps *verified against mobile-hub's own code this session* — highest trust, cite-able, specific file/line references. Lower sections are patterns observed in the comparison material, not yet checked against our code.
2. **`02-ui-ux-patterns.md`** — generic UI/UX interaction ideas worth considering. Lower confidence than file 1; these are candidates, not verified gaps.
3. **`03-gaps-vs-existing-traceability.md`** — maps everything in files 1–2 onto the existing rows in `docs/SOURCE_FEATURE_TRACEABILITY.md`, so it's clear what's newly confirmed evidence for an existing disposition versus a genuinely new, previously-untracked capability.
4. **`04-open-questions-and-next-steps.md`** — decisions that need a person, not a doc, before any of this becomes a committed plan.

## Status

Staging material only, produced 2026-09-14. Not yet merged into the live tracker docs. Do not treat anything here as "planned" or "in progress" until it's been explicitly moved into `docs/TODO.md`/`docs/SOURCE_FEATURE_TRACEABILITY.md` following a planning discussion.
