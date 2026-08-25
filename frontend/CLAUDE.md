# Mobile Hub — Frontend

React app: device grid, live device viewer(s), execution/build pipeline UI, analytics dashboard. See root `../CLAUDE.md` for cross-cutting rules — this file is frontend-only conventions and gotchas.

**Status:** implemented and rendering real backend data. All five sections exist, typecheck/lint/build pass, and the app has been verified in a real browser against a live backend in both themes. See `docs/TODO.md` (repo root) for the live checklist before assuming what works.

## Visual design — read this first

**`docs/ui-guidelines.md` is the visual source of truth.** Aesthetic target: Linear density + Vercel restraint + Stripe data clarity. Before touching anything visual, read it — do not invent a parallel design system.

The foundation is built and in use across every page:

- `src/styles/tokens.css` — all color/type/spacing/radius/motion tokens, dark (default) + light via `data-theme`. **Components consume tokens only; never hard-code a hex in a component.**
- `src/lib/icons.ts` — the single Lucide mapping. Import icons from here, never reference a Lucide name directly in a component.
- `src/lib/status.ts` + `components/ui/StatusBadge.tsx` — the only place a status becomes pixels. Always color **+ icon + text**; never color alone.
- `components/ui/layout.tsx` — `Page`, `PageHeader`, `Card`, `Grid`, `List`, `Meta`, `Summary`, `ProgressBar` (4px), `DescriptionList`.
- `components/ui/states.tsx` — `QueryBoundary` renders loading (skeletons, never a full-page spinner) / error / empty. Every list page routes through it.
- `components/ui/Button.tsx`, `Field.tsx` (labelled input with aria-describedby errors), `BrandLogo.tsx`, `lib/theme.ts` (theme toggle, persisted).
- `features/auth/` — `AuthProvider` + `useAuth()`. Reads are public; only actions are role-gated. **Hide an action the caller can't perform rather than disabling it** — never render a control whose only outcome is a 401/403.

Still to build from the guidelines' component list: `Toast`, `Dialog`/slide-over, `Tabs`/filter bar, themed TanStack Table, Recharts trend charts, URL-synced filters.

## Core principles

- Follow whatever this repo actually establishes (framework, structure, state approach, naming) once scaffolded — this file wins over generic instinct, but a later real decision in this file wins over a stale one.
- Reuse existing components/hooks/utils/API clients/schemas/tokens before creating new ones.
- Keep business/data logic separate from presentation when complexity warrants it; don't split trivial components just to satisfy a rule.
- Loading, empty, error, and disabled states are part of "done," not a follow-up.
- Avoid unnecessary dependencies — platform APIs and `Intl` first, a package only when it earns its weight.

## Intended stack

- React 18, Vite, TypeScript (strict mode on)
- Package manager: **npm** (locked — see root CLAUDE.md)
- Lint/format: ESLint + Prettier; test: Vitest + React Testing Library + `@testing-library/user-event`; E2E: Playwright
- Server state: TanStack Query (React Query) — this app is server-state-heavy (device status, execution events, live logs)
- Global client state: only if something is genuinely cross-cutting and not server data (e.g. active-machine filter) — a lightweight store (Zustand) over Redux unless a strong reason emerges. Do not put server data into a client-state store when React Query already owns it.
- Validation: `zod` for forms, URL/query params, and any external API response not fully trusted
- Forms: native state for simple ones; `react-hook-form` + `zod` + `@hookform/resolvers` for complex ones (build trigger form, server registration)
- Tables: TanStack Table for the device/build lists if sorting/filtering grows past what plain HTML tables handle; TanStack Virtual for long log views and large device grids
- Charts (analytics dashboard): one lightweight lib (e.g. Recharts) — avoid pulling in a full charting suite for a handful of KPI cards
- Icons: pick one icon library (`lucide-react` is a reasonable default) and don't mix families

## Suggested project structure

Feature-oriented once the app grows past a handful of screens — adapt, don't force:

```text
src/
  app/                    router setup, providers, layout shell
  features/
    devices/              device grid, device viewer, streaming
      components/ hooks/ api/ schemas/ types/
    execution/             build/install/run pipeline, log viewer
    servers/               Appium server list/registration
    analytics/             KPI cards, trend charts
  components/ui/           genuinely reusable primitives (buttons, dialogs)
  hooks/                    cross-feature hooks
  services/                 API clients, websocket/SSE client
  lib/ utils/ types/
  test-utils/
```

Avoid one giant `components/` or `utils/` dumping ground once features multiply.

## Dev loop (verified 2026-08-25)

```
npm run dev         # vite — http://localhost:5173, proxies /api and /ws to :3000
npm run build        # tsc && vite build
npm run lint          # eslint src --ext .ts,.tsx
npm run typecheck     # tsc --noEmit
npm test               # vitest run — 12 tests over lib/format and lib/status
```

`npm run dev` proxies `/api` to the backend on :3000, so run the backend too or every list shows its error state. Because the proxy handles the prefix, `VITE_API_URL` should be left unset locally — see the `services/api.ts` note about the prefix always being appended.

## Architecture rules

- **Do** keep live-streaming components (device viewer, multi-device grid) isolated from the general CRUD UI (device list, build list) — they have different re-render/perf profiles and different failure modes (a dropped WebSocket shouldn't break the rest of the app).
- **Do** treat the execution pipeline view (build → install → run stages) as a state machine driven by backend-pushed events, not client-side polling assumptions baked into components. A discriminated union works well for this:
  ```ts
  type ExecutionState =
    | { status: 'queued' }
    | { status: 'running'; stage: string }
    | { status: 'done'; result: ExecutionResult }
    | { status: 'error'; error: Error };
  ```
- **Not** fetch-in-component. Route all server communication through a service/hook layer so streaming vs REST vs SSE swaps don't ripple through every screen.
- **Not** silent reconnect loops without a visible connection-state indicator — device streams will drop; the UI must show it, not hide it.

## Validation, errors, and API contracts

- Never trust an API response as typed without runtime validation at the boundary when the contract isn't guaranteed (prefer a generated/shared type from the backend when one exists — don't hand-duplicate dozens of interfaces).
- Normalize API errors centrally into one shape (`{ code, message, requestId? }`); never surface raw backend stack traces to users. Keep technical detail in telemetry only.
- Every async feature considers: initial load, background refresh, empty result, partial data, failure, retry. Skeletons over full-screen spinners for anything that isn't the first paint.

## Accessibility & security (non-negotiable, not optional)

- Semantic HTML, real `<button>`s for actions, labeled form controls, visible focus states, keyboard navigation preserved, no color-only state signaling.
- Never `dangerouslySetInnerHTML` on unsanitized content (use `DOMPurify` if genuinely needed); treat URL params and any external data as untrusted; no secrets in frontend env vars or bundles; validate redirect targets.

## Known gotchas to design around (from reference architecture)

- MJPEG/H264 device streams are resource-heavy per viewer. If the backend shares one capture across N viewers, the frontend must not assume closing one viewer tab is free — confirm the actual fan-out contract with backend before building multi-viewer UI.
- Auto-scroll + ANSI log rendering (execution log viewer) is a common perf trap at scale — virtualize long logs, don't render every line into the DOM.
- Toast/notification spam from high-frequency execution events (per-device, per-stage) needs debouncing/grouping — don't wire raw event → toast 1:1.

## Do this, not that

- **Do** ask before adding a new UI framework/component library, or any new top-level dependency — state why it's needed.
- **Do** ask before adding a new dependency if an existing project utility already solves the problem.
- **Not** introduce a second state-management pattern alongside whatever's already in use "because it's cleaner for this one screen."
- **Not** use `any`, unsafe type assertions, or effects for values that can be computed during render (derived state belongs in a `const`, not a `useEffect` + `setState`).
- **Not** bundle unrelated visual/architectural refactors into a scoped change.

## Pre-completion checklist

- [ ] typecheck, lint, and format pass
- [ ] relevant unit/component tests pass; E2E for the critical journey if one was touched
- [ ] loading / empty / error states handled; repeated-submit is guarded
- [ ] keyboard interaction + accessible labels verified; responsive at narrow widths
- [ ] API errors normalized; no sensitive data exposed in the bundle or logs
- [ ] no unnecessary dependency introduced; new ones explained in the PR

## Recommended Claude Skills for this package

If these skills are installed/available in a session working on `frontend/`, prefer invoking them over ad-hoc judgment for their respective concerns (source: [Top Claude Skills for UI/UX Engineers](https://snyk.io/articles/top-claude-skills-ui-ux-engineers/)):

| Skill | Use for |
|---|---|
| Anthropic Frontend Design | Avoiding generic "every AI UI looks the same" output — distinctive typography, color, layout for the dashboard/device grid/analytics screens |
| Vercel React Best Practices | React/Vite performance review — waterfall elimination, bundle size, before micro-optimizing |
| Vercel Composition Patterns | Structuring device-grid / multi-viewer / execution-pipeline components as compound components instead of boolean-prop-heavy ones |
| AccessLint | Contrast + WCAG 2.1 checks — non-negotiable for a community/OSS tool with unknown-ability contributors and users |
| UI/UX Pro Max | Picking a coherent style/palette when we design the dashboard, instead of ad-hoc color choices |
| Vercel Web Design Guidelines | General pre-PR sanity check against common web interface rules |

Not currently installed as of this planning session — none of the above are in this repo's skill list yet. Treat this table as a shortlist to install when scaffolding the frontend, not as tools already available; verify with the skill listing before invoking any of them by name.
