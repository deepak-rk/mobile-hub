# Mobile Hub — UI Guidelines

**Status:** source of truth for visual design and frontend implementation  
**Audience:** designers, frontend engineers, and AI coding sessions  
**Aesthetic target:** Linear density + Vercel restraint + Stripe data clarity

This document is the single place for all visual and interaction rules.  
When building or reviewing UI, follow this file — do not invent parallel systems.

---

## 1. Design Philosophy

Mobile Hub is a **precision instrument**, not a generic SaaS dashboard.

### Five non-negotiable principles

1. **Restraint over decoration** — One accent color. Almost everything else is luminance and hierarchy.
2. **Density with breathing room** — Information-dense screens (device grid, run list, analytics) without visual clutter.
3. **Real-time states are first-class** — Never hide connection, lock, stage, or stream status. Silent failure is forbidden.
4. **Status is never color-only** — Always pair color with icon, label, or pattern.
5. **Keyboard + accessibility from day one** — Focus rings, ARIA, and keyboard navigation are required.

### Target feeling

Calm precision of **Linear** + editorial restraint of **Vercel** + data clarity of **Stripe Dashboard**, applied to a device-lab surface.

### Primary references

| Reference | Use for |
|-----------|---------|
| **Linear** | Density, dark mode, micro-interactions, keyboard-first craft |
| **Vercel (Geist)** | Restraint, type, shell, empty states, black/white discipline |
| **Stripe Dashboard** | Tables, forms, status patterns, trustworthy data presentation |
| **Raycast** | Secondary inspiration for focused detail panels |

**Avoid:** Material Design defaults, Bootstrap-era patterns, neon “AI SaaS” gradients, heavy illustration systems, and the current BrowserStack / Sauce Labs visual language.

---

## 2. Brand Identity

**Name:** Mobile Hub  
**Tone:** Precision instrument — calm, technical, trustworthy

### Mark

- **Primary mark:** Geometric hexagon (or rounded square) with a simple device outline / “M” monogram
- **Wordmark:** `Mobile Hub` in Inter or Geist Sans, weight 510–600
- **Favicon / app icon:** Mark only

### Color usage

| Element | Color |
|---------|-------|
| Logo mark | Accent (`#5e6ad2`) or pure white on dark backgrounds |
| Wordmark | `--text-primary` |
| Accent | CTAs, active nav, live indicators, progress fill **only** |

### Rules

- Never put gradients on the logo
- Never use multi-color logo variants
- Never mix font weights inside the wordmark
- Prefer the mark alone in tight spaces (favicon, mobile header)

---

## 3. Color System

Dark mode is the **primary** experience. Light mode must be equally polished.

### Dark (default)

```css
:root {
  /* Canvas & surfaces */
  --bg-canvas: #08090a;
  --bg-panel: #0f1011;
  --bg-elevated: #161618;
  --bg-hover: #1c1c1f;
  --bg-active: #222225;

  /* Borders */
  --border-subtle: rgba(255, 255, 255, 0.06);
  --border-default: rgba(255, 255, 255, 0.09);
  --border-strong: rgba(255, 255, 255, 0.14);

  /* Text */
  --text-primary: #f7f8f8;
  --text-secondary: #a1a1aa;
  --text-tertiary: #71717a;
  --text-disabled: #52525b;

  /* Accent (single brand color) */
  --accent: #5e6ad2;
  --accent-hover: #6e79e0;
  --accent-muted: rgba(94, 106, 210, 0.15);

  /* Semantic status */
  --status-idle: #22c55e;
  --status-smoke: #eab308;
  --status-in-use: #f97316;
  --status-offline: #71717a;
  --status-running: #3b82f6;
  --status-passed: #22c55e;
  --status-failed: #ef4444;
  --status-cancelled: #a1a1aa;
}
```

### Light

```css
[data-theme="light"] {
  --bg-canvas: #fafafa;
  --bg-panel: #ffffff;
  --bg-elevated: #ffffff;
  --bg-hover: #f4f4f5;
  --bg-active: #e4e4e7;

  --border-subtle: rgba(0, 0, 0, 0.06);
  --border-default: rgba(0, 0, 0, 0.09);
  --border-strong: rgba(0, 0, 0, 0.14);

  --text-primary: #09090b;
  --text-secondary: #52525b;
  --text-tertiary: #71717a;
  --text-disabled: #a1a1aa;

  --accent: #4f46e5;
  --accent-hover: #4338ca;
  --accent-muted: rgba(79, 70, 229, 0.1);
}
```

Apply theme via `data-theme="dark" | "light"` on `<html>`.

---

## 4. Typography

| Role | Family | Notes |
|------|--------|-------|
| UI / Body | Inter Variable or Geist Sans | Prefer OpenType `cv01` + `ss03` if available |
| Mono | Geist Mono or JetBrains Mono | UDIDs, logs, commands, checksums |

**Weights**
- 400 — body
- 510–520 — UI labels (Linear signature weight)
- 600 — headings

**Sizes**
- Dense UI: 13–14 px
- Body copy: 15–16 px
- Page titles: 20–24 px

**Tracking:** Tight (−0.02em to −0.04em) on larger headings.

---

## 5. Spacing, Radius, Elevation

### Spacing scale (4 px base)

`4, 8, 12, 16, 20, 24, 32, 40, 48, 64`

### Radius

| Element | Radius |
|---------|--------|
| Controls / badges | 6 px |
| Cards / panels | 8 px |
| Modals / large surfaces | 12 px |
| Status pills only | 9999 px (full pill) |

### Elevation

- **Dark:** Prefer surface luminance steps over heavy shadows. Borders do most of the work.
- **Light:** Soft `0 1px 2px rgba(0,0,0,0.04)` + border.
- Never stack multiple shadow levels on the same element.

---

## 6. Icons

**Library:** Lucide Icons (consistent 1.5–2 px stroke).

### Size scale

| Context | Size |
|---------|------|
| Tables / dense UI | 14 px |
| Buttons / badges | 16 px |
| Page headers | 20 px |
| Empty states | 24 px |

### Domain mapping (lock this)

| Concept | Lucide icon |
|---------|-------------|
| Device | `Smartphone` |
| Lock held | `Lock` |
| Available / Unlock | `LockOpen` |
| Live stream | `Radio` or `Video` |
| Running / Execute | `Play` / `PlayCircle` |
| Passed | `CheckCircle2` |
| Failed | `XCircle` |
| Cancelled | `MinusCircle` |
| Downloading | `Download` |
| Validating | `ShieldCheck` / `Loader2` |
| Corrupt | `AlertTriangle` |
| Ready | `PackageCheck` |
| Host / Machine | `Server` |
| Offline | `WifiOff` |
| Analytics | `BarChart3` |
| Builds | `Package` |
| Execution | `Terminal` |

**Rule:** Every status shows **color + icon + text**. Never color alone.

Put the mapping in a single `icons.ts` (or equivalent) and import from there — do not scatter icon names across components.

---

## 7. Semantic Status System

| State | Token | Icon | Label example |
|-------|-------|------|---------------|
| Idle / Online | `--status-idle` | Filled circle | Online / Idle |
| Smoke | `--status-smoke` | Filled circle | Smoke |
| In use | `--status-in-use` | Lock + circle | In use · {user} |
| Offline / Unreachable | `--status-offline` | Hollow circle | Offline |
| Running | `--status-running` | Pulsing circle | Running |
| Passed | `--status-passed` | Check | Passed |
| Failed | `--status-failed` | X | Failed |
| Cancelled | `--status-cancelled` | Dash | Cancelled |

Implement as a shared `StatusBadge` / `StatusPill` component. Do not re-implement status rendering per page.

---

## 8. Download & Progress UI (Builds)

This is one of the most important real-time surfaces in the product.

### Builds table states

| Status | Visual |
|--------|--------|
| `queued` / `pending` | Muted text + slow `Loader2` |
| `downloading` | Thin progress bar + % + `Download` icon + bytes |
| `validating` | 100% bar + “Validating…” + `ShieldCheck` |
| `ready` | Green check + file size |
| `corrupt` / `error` | Warning icon + message + **[Retry]** button |

### Progress bar rules

- Height: **4 px**
- Track: `--border-subtle`
- Fill: `--accent` while downloading → `--status-passed` when validating completes
- Label: `67% · 32 MB / 48 MB` (when size is known)
- Updates: real-time via WebSocket (`/ws/builds/jobs/:jobId`) — **no polling**

### Detail / slide-over (optional)

When a user opens a downloading build:

- Larger progress indicator
- `downloadedBytes / sizeBytes`
- Checksum status: pending → computing → matched / mismatched
- Cancel action (if supported)

### Empty & error states

- No builds → “No builds yet. Fetch your first artifact.” + **[Fetch build]**
- Corrupt → clear error + Retry
- Network failure → “Download failed. Check connection or artifact URL.”

---

## 9. Component Primitives (build order)

1. `Button` — primary (accent), secondary (ghost/outline), destructive; sizes sm / md
2. `StatusBadge` / `StatusPill`
3. `Card` (device card, KPI card)
4. `Table` (style TanStack Table — already a dependency)
5. `Input` / `Select` / `Combobox`
6. `Skeleton` (mandatory for all lists)
7. `EmptyState` (contextual + next action)
8. `Toast` (bottom-right, grouped)
9. `Dialog` / slide-over panel
10. `Tabs` / filter bar
11. `ProgressBar` (4 px, accent fill)
12. `StreamStatusBanner` (connecting / live / reconnecting / dropped)

All interactive elements must have a visible `:focus-visible` ring using the accent at reduced opacity.

---

## 10. Domain Screen Patterns

### App shell

- Top nav only (no persistent sidebar)
- Logo mark + wordmark + primary sections + user menu with role badge
- Toast region: bottom-right

### Device Grid

- Card grid with low-rate MJPEG thumbnail
- Status dot + label
- Lock badge with username when held
- Filters URL-synced
- Footer summary: total · online · in use · offline

### Device Viewer

- Large stream area + right info panel
- `StreamStatusBanner` is non-negotiable
- Protocol switch (MJPEG ↔ H264) without page reload
- Lock section + viewer count + active run (if any)

### Builds Library

- Table with inline progress for in-flight jobs
- Corrupt row shows error + Retry
- Fetch opens a slide-in panel (not a full page)

### Execution

- Pipeline column driven by WebSocket stage events (not polling)
- Live log via SSE; auto-scroll with “Jump to latest”
- Cancel only while non-terminal; hidden after terminal state

### Analytics

- Six-zone layout (KPI strip, pass-rate trend, volume, flakiness, device utilisation, recent failures)
- Recharts only (`LineChart`, stacked `BarChart`)
- All filters URL-synced

---

## 11. Motion

- Most transitions: 120–180 ms ease-out
- Prefer `opacity` and `transform` only
- Stream reconnect: subtle pulse on LIVE indicator — never jarring
- Stage transitions: soft fade + slight height change
- No decorative parallax or heavy page transitions

---

## 12. Accessibility (non-negotiable)

- Visible `:focus-visible` rings on all interactive elements
- Text contrast ≥ 4.5:1; large UI ≥ 3:1
- Every status has text or `aria-label`
- Live regions (`aria-live`) for stage changes and critical toasts
- Stream viewer remains operable if WebSocket drops (banner + retry)
- Tables and grids are keyboard-navigable

---

## 13. Implementation Guidance

### Tokens

Define all colors, spacing, radii, and type as CSS custom properties (or a Tailwind theme extension).  
Components consume tokens only — no hard-coded hex in component files.

### Stack alignment

| Need | Choice |
|------|--------|
| Primitives | Radix UI (or heavily themed shadcn/ui) + these tokens |
| Tables | TanStack Table (already in project) |
| Charts | Recharts (already in project) |
| Icons | Lucide |
| Fonts | Inter Variable + Geist Mono / JetBrains Mono |

### Frontend priority order

```
1. Design tokens (CSS variables / Tailwind theme)
2. icons.ts                    → Lucide mapping
3. StatusBadge.tsx             → color + icon + label
4. ProgressBar.tsx             → 4 px thin bar
5. BrandLogo.tsx               → mark + wordmark variants
6. BuildStatusCell.tsx         → table cell with live progress
7. Device Grid polish
8. Execution detail (WS stages + SSE logs)
9. Analytics zones
```

### Daily working rule

One screen per day. Do not redesign the whole app in a single pass.

---

## 14. States every screen must handle

| State | Approach |
|-------|----------|
| Loading | Skeleton placeholders (not full-screen spinner) |
| Empty | Contextual message + next action |
| Error | Inline error with retry; shape `{ code, message }` |
| Stale / reconnecting | Visible banner or badge — never silent |
| Unauthorized | Hide actions by role; direct access → 403 page |

---

## 15. What “done” looks like for a design pass

- Tokens live in one place and are used everywhere
- StatusBadge and ProgressBar are shared components
- Builds page shows live download progress via WebSocket
- Device Grid shows status + lock correctly
- Dark and light themes both work
- Focus rings and keyboard nav work on primary flows
- No color-only status anywhere
- Empty / loading / error states exist on every list

---

## 16. Changelog of decisions (this document)

| Decision | Choice |
|----------|--------|
| Primary aesthetic | Linear + Vercel + Stripe |
| Dark-first | Yes |
| Accent | Single indigo `#5e6ad2` |
| Icon library | Lucide |
| Progress bar height | 4 px |
| Status rule | Color + icon + text always |
| Layout | Top nav only |
| Chart library | Recharts only |
| Table library | TanStack Table |

---

*End of UI Guidelines. Treat this file as the visual source of truth for Mobile Hub.*
