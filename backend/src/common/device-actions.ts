import { z } from 'zod';

/**
 * What a person can ask a phone to do from the hub: press a button, tap,
 * swipe, type, rotate, reboot. Shared by the hub (validates a request) and
 * the agent (runs it), so the two can never disagree on what an action is.
 *
 * Tap and swipe take coordinates as fractions of the screen (0–1), not
 * pixels: the person clicks on a scaled stream image, and only the agent can
 * read the phone's real size in its current orientation.
 */
export const DEVICE_KEYS = ['home', 'back', 'app_switch', 'power', 'volume_up', 'volume_down', 'enter'] as const;

/** Android key codes (`input keyevent`). */
export const ANDROID_KEYCODES: Record<(typeof DEVICE_KEYS)[number], number> = {
  home: 3,
  back: 4,
  app_switch: 187,
  power: 26,
  volume_up: 24,
  volume_down: 25,
  enter: 66,
};

const fraction = z.number().min(0).max(1);

export const deviceActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('key'), key: z.enum(DEVICE_KEYS) }),
  z.object({ kind: z.literal('tap'), x: fraction, y: fraction }),
  z.object({
    kind: z.literal('swipe'),
    x1: fraction,
    y1: fraction,
    x2: fraction,
    y2: fraction,
    durationMs: z.number().int().min(50).max(5000).default(300),
  }),
  // Printable ASCII only: Android's `input text` cannot send a newline or a
  // tab, and drops or garbles characters outside ASCII.
  z.object({
    kind: z.literal('text'),
    text: z.string().min(1).max(500).regex(/^[\x20-\x7e]+$/, 'printable ASCII text only'),
  }),
  // 0 = natural portrait, 1 = 90°, 2 = 180°, 3 = 270°.
  z.object({ kind: z.literal('rotate'), rotation: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) }),
  z.object({ kind: z.literal('reboot') }),
]);

export type DeviceAction = z.infer<typeof deviceActionSchema>;

/** One line for a job list or a dry run. Never includes typed text: it may be a password. */
export function describeAction(action: DeviceAction): string {
  switch (action.kind) {
    case 'key':
      return `press ${action.key}`;
    case 'tap':
      return `tap at ${pct(action.x)}, ${pct(action.y)}`;
    case 'swipe':
      return `swipe ${pct(action.x1)}, ${pct(action.y1)} → ${pct(action.x2)}, ${pct(action.y2)} in ${action.durationMs} ms`;
    case 'text':
      return `type ${action.text.length} character(s)`;
    case 'rotate':
      return `rotate to ${action.rotation * 90}°`;
    case 'reboot':
      return 'reboot';
  }
}

function pct(f: number): string {
  return `${Math.round(f * 100)}%`;
}
