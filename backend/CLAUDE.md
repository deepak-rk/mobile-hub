# Mobile Hub — Backend

Node.js API + services: device inventory, Appium server orchestration, execution pipeline, log/artifact streaming, analytics aggregation. See root `../CLAUDE.md` for cross-cutting rules — this file is backend-only conventions and gotchas.

**Status:** feature-complete — `auth`, `hosts`, `devices`, `config`, `builds`, `execution`, `streaming` and `analytics` are all built and verified against a running server, plus a standalone device agent (`src/agent/`). See `docs/TODO.md` (repo root) for the live checklist and the remaining gaps. Dev loop below is real and verified.

## Core principles

- Follow whatever this repo actually establishes once scaffolded over generic instinct — but a later real decision recorded here wins over a stale one.
- Separate transport/API concerns from business logic from infrastructure. Keep modules small and cohesive.
- Reuse existing schemas, error classes, loggers, clients, and test utilities before writing new ones. Avoid premature generalization — extract shared helpers only on real reuse.
- Never silently swallow exceptions. Never expose secrets, tokens, stack traces, or raw SQL in logs or API responses.

## Intended stack

- Node.js LTS, TypeScript (strict), ESM unless a compatibility need forces CommonJS
- Package manager: **npm** (locked — see root CLAUDE.md)
- Framework: **Fastify** (locked) — plugin ecosystem for CORS/helmet/rate-limit/JWT/swagger, lighter ceremony than NestJS, faster than Express. Don't reach for NestJS-style DI/decorators unless a real need emerges.
- DB: **MongoDB/Mongoose** (locked) — see `docs/architecture-blueprint.md` for the schema design.
- Real-time: WebSockets for device streams and live log tail; decide SSE vs WS per use case rather than defaulting to one everywhere.
- Validation: `zod` everywhere untrusted data enters — HTTP body/query/params, env vars, external responses, queue payloads.
- Logging: structured logger (`pino`) with correlation/request IDs; never log secrets, tokens, or PII.
- Lint/format: ESLint + Prettier; test: Vitest + Supertest for HTTP integration tests.

## Suggested project structure

```text
src/
  app/                app.ts, server.ts
  config/             env.ts (validated at startup), constants.ts
  modules/
    devices/          controller, service, repository, schema, routes
    servers/           Appium server orchestration
    execution/          orchestration, log streaming, artifact handling
    analytics/
  common/              errors/ middleware/ utils/ types/ logging/
  infrastructure/      database/ messaging/ external-clients/
  tests/
```

Keep domain code together (controller/service/repository per module) rather than grouping by technical layer across the whole app.

## Dev loop (verified 2026-08-22)

```
npm run dev         # tsx watch src/server.ts — API on :3000 (API_PORT)
npm run agent        # the host-side device agent (see below); AGENT_DISCOVERY=synthetic to run with no devices
npm run build         # tsc
npm run lint           # eslint src --ext .ts
npm run typecheck      # tsc --noEmit
npm test                # vitest run — 92 tests, no database required
```

`dev` requires `MONGODB_URI` reachable and `JWT_SECRET` (32+ chars) in `backend/.env` — see `backend/.env.example`. `typecheck`/`lint`/`build`/`test` need neither Mongo nor a device: the tests stub the database and use the synthetic capture/discovery sources. For `dev`, a plain `docker run -d -p 27017:27017 mongo:7` is enough.

## The device agent (`src/agent/`)

A **standalone CLI that runs on each host machine in the lab**, not inside the server — separate entry point (`npm run agent`), separate env vars, and in a real deployment a separate box. It discovers attached devices and reports them to the hub over the public API; the hub owns all reconciliation.

- Keep it dumb and stateless. `POST /api/devices/sync` already marks anything no longer reported as offline and releases its locks, so the agent's only job is to report the truth about its host. That is what makes a restart or a missed poll self-heal.
- **Never let a failed poll kill the loop** — a hub restart or network blip must not require someone to walk over to the host machine.
- `console` is the agent's real interface (no pino, no request context), so `no-console` is disabled for `src/agent/**` in `.eslintrc.json`. That exemption is for the agent only; server code still logs through pino.
- Discovery is pluggable (`DeviceDiscovery`), same as `CaptureSource` and `BuildProvider`. `AGENT_DISCOVERY=synthetic` reports fixture devices so the agent is runnable with no hardware attached — opt-in only, so a real host with broken adb fails visibly instead of quietly reporting fake devices.

## Architecture rules

- **Do** put all device/session/execution state mutation behind a service layer (`XService`), never directly in controllers — matches the reference's pattern and keeps controllers thin/testable.
- **Do** design multi-host support (multiple machines running device agents) into the data model from the first schema, with an explicit host/machine identifier on any shared state — this was the most expensive retrofit in the reference architecture.
- **Do** make device-lock / in-use state explicit and queryable, not inferred from execution logs.
- **Do** validate every untrusted boundary (HTTP body/query/params, env vars, external API responses, queue payloads) with `zod` — never `req.body as SomeType` without runtime validation.
- **Do** use typed domain errors (`ValidationError`, `NotFoundError`, `ConflictError`, `ExternalServiceError`, etc.) with a stable code and safe message, mapped to HTTP status centrally — not ad-hoc `throw new Error(string)` scattered through services.
- **Not** let a single service own both orchestration (starting/stopping processes) and reporting (aggregating results) — split them so a reporting bug can't stall an execution run.
- **Not** poll where a push/event model is available — the reference's execution pipeline relies on interval polling in places; prefer WS-pushed state transitions for new code.
- **Not** call third-party SDKs (Appium client, cloud device farms, etc.) from many unrelated modules — wrap them behind one adapter per external service for centralized auth/timeout/retry and easier testing.

## Known gotchas to design around (from reference architecture)

- **Streaming fan-out:** decide explicitly whether a device capture (adb screenrecord / xcrun simctl) is shared across N viewers or spawned per-viewer. Per-viewer is simpler but doesn't scale; shared-with-fanout needs a buses/registry map keyed by device UID from day one.
- **Zip/artifact integrity:** validate downloaded build artifacts (checksum or size sanity check) before marking a build "ready" — silent truncation was a real failure mode in the reference.
- **npm/build cache correctness:** cache keys must include everything that invalidates the cache (e.g. package.json hash) — a stale cache masquerading as valid was a past incident class.
- **Process cleanup:** any spawned child process (Appium server, adb screenrecord, wdio runner) needs a guaranteed cleanup path (on success, failure, AND on backend restart) — orphaned device-locking processes are a recurring pain point in this domain.
- **Auth/RBAC:** even a minimal v1 should scope roles (e.g. viewer vs operator vs admin) in the schema/middleware layer from the start — retrofitting touches every route.

## Security & operational defaults

- Least privilege; verify authorization at the resource/action level, not just authentication. Rate-limit sensitive endpoints (build trigger, server registration). Set secure headers (`helmet`) and configure CORS explicitly.
- Hash passwords with `argon2` if we ever store them; never hand-roll crypto; never decode a JWT and trust it without verifying signature + claims (`jose` for standards-based JWT work).
- Async/concurrency: bounded concurrency for large fan-out (`p-limit`), explicit timeouts on every network call, retries only when idempotent and with backoff + jitter — never blind-retry a non-idempotent operation (e.g. don't retry "start execution run" without an idempotency key).
- Don't block the event loop with CPU-heavy sync work (log parsing, artifact hashing) — push it to a worker thread or background job if it grows past trivial.

## Do this, not that

- **Do** ask before adding a new top-level dependency (esp. anything that spawns processes or touches the filesystem — security-sensitive in this domain). State why it's needed.
- **Do** ask before adding a dependency if an existing project utility already solves the problem, or a native Node/platform API does.
- **Not** hardcode host/port/paths — this system inherently runs across multiple machines; anything host-specific must be config, validated at startup, not a literal.
- **Not** rename public routes/contracts without explicit instruction; preserve backward compatibility unless the task intentionally breaks it.

## Pre-completion checklist

- [ ] typecheck, lint, and format pass
- [ ] relevant unit + integration tests pass
- [ ] input validation present at every new boundary; errors mapped through the typed-error scheme
- [ ] logs carry useful context (correlation ID) without secrets
- [ ] authorization verified where required; new endpoints rate-limited if sensitive
- [ ] external calls have timeout + error handling; no unbounded concurrency introduced
- [ ] DB changes have migrations; no N+1 introduced
- [ ] no unnecessary dependency introduced; new ones explained in the PR

## Recommended Claude Skills for this package

From [Trail of Bits' skills repo](https://github.com/trailofbits/skills) (`.agents/skills` marketplace, security-firm-maintained, not an SEO listing site) — high relevance here because this backend spawns child processes (Appium, adb, wdio) and pulls npm dependencies, both flagged as security-sensitive above:

| Skill | Use for |
|---|---|
| `supply-chain-risk-auditor` | Vetting new npm dependencies (advisories, abandoned upstreams, install scripts) before we add them — pairs directly with the "ask before adding a dependency" rule above |
| `differential-review` | Security-focused review of a diff against git history — good default for PRs touching the service layer |
| `insecure-defaults` | Catching fail-open defaults — relevant to device-lock and RBAC scoping decisions |
| `sharp-edges` | Flagging footgun APIs/configs — useful when wiring child-process spawning and cleanup |
| `static-analysis` | CodeQL/Semgrep pass for deeper audits, not needed for every PR |

Not currently installed as of this planning session — verify with the skill listing before invoking any by name, same caveat as the frontend list.

**Caution on third-party skill marketplaces generally:** a Skill is executable instructions the agent follows, so installing an unvetted one is itself a supply-chain risk (the exact class of problem `supply-chain-risk-auditor` above checks for in dependencies). Prefer the official [anthropics/skills](https://github.com/anthropics/skills) repo and known-maintainer repos (like Trail of Bits) over generic "top Claude skills" listicle sites, which are frequently SEO content with no accountability for what the skill actually does.
