import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards WCAG AA (4.5:1) for status text in both themes.
 *
 * StatusBadge paints its label in `--status-*` on a tint of that same colour
 * (N% of it over the surface), at --text-xs — small text, so 4.5:1 is the bar.
 * This reads the real tokens.css and StatusBadge.module.css, so changing a
 * status colour, the tint strength or a surface colour can't silently drop
 * contrast below AA.
 */

const stylesDir = __dirname;
const tokensCss = readFileSync(resolve(stylesDir, 'tokens.css'), 'utf8');
const badgeCss = readFileSync(resolve(stylesDir, '../components/ui/StatusBadge.module.css'), 'utf8');

/** Custom properties declared directly inside the first block whose selector matches. */
function block(selector: string): Record<string, string> {
  const start = tokensCss.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector not found in tokens.css: ${selector}`);
  const body = tokensCss.slice(start, tokensCss.indexOf('}', start));
  const vars: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[name] = value.trim();
  return vars;
}

const dark = block(':root');
const lightOverrides = block("[data-theme='light']");
const systemLightOverrides = block(":root:not([data-theme='dark']):not([data-theme='light'])");
const themes = {
  dark,
  'light ([data-theme])': { ...dark, ...lightOverrides },
  'light (prefers-color-scheme)': { ...dark, ...systemLightOverrides },
};

const tintMatch = /background:\s*color-mix\(in srgb, var\(--status-color\) (\d+)%, transparent\)/.exec(badgeCss);
if (!tintMatch) throw new Error('badge tint not found in StatusBadge.module.css');
const tint = Number(tintMatch[1]) / 100;

type Rgb = [number, number, number];

function hex(value: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(value);
  if (!m) throw new Error(`expected a #rrggbb colour, got: ${value}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `color-mix(in srgb, fg N%, transparent)` composited over an opaque surface. */
function over(fg: Rgb, surface: Rgb, alpha: number): Rgb {
  return fg.map((c, i) => c * alpha + surface[i] * (1 - alpha)) as Rgb;
}

// Every surface a badge can sit on (pages, panels, dialogs, hovered table rows).
const surfaces = ['--bg-canvas', '--bg-panel', '--bg-elevated', '--bg-hover'];
const statuses = Object.keys(dark).filter((name) => name.startsWith('--status-'));

describe('status colour contrast (WCAG AA, 4.5:1)', () => {
  it('finds the status tokens and tint', () => {
    expect(statuses.length).toBeGreaterThanOrEqual(8);
    expect(tint).toBeGreaterThan(0);
  });

  it('keeps the explicit and OS-preference light blocks identical', () => {
    expect(systemLightOverrides).toEqual(lightOverrides);
  });

  for (const [theme, vars] of Object.entries(themes)) {
    for (const status of statuses) {
      it(`${theme}: ${status}`, () => {
        const fg = hex(vars[status]);
        for (const surfaceToken of surfaces) {
          const surface = hex(vars[surfaceToken]);
          // Pill badge (tinted background) and the bare variant (no background).
          expect(contrast(fg, over(fg, surface, tint)), `${status} on tinted ${surfaceToken}`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(fg, surface), `${status} on bare ${surfaceToken}`).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }
});
