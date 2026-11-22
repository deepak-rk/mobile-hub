import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as os from 'os';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  // Ephemeral per-run working directory: git checkout, restored node_modules,
  // scratch files. Deleted when the run ends.
  EXECUTIONS_DIR: z.string().default(path.join(os.homedir(), 'mobile-hub-executions')),
  // Durable per-run artifacts: run.log, and later the Allure report. Kept
  // after the run so history stays readable. Deliberately a separate root
  // from EXECUTIONS_DIR — they had the same lifetime before, which made
  // "delete the workspace when the run ends" and "serve a finished run's log"
  // mutually exclusive requirements.
  EXECUTION_ARTIFACTS_DIR: z.string().default(path.join(os.homedir(), 'mobile-hub-artifacts')),
  BUILDS_DIR: z.string().default(path.join(os.homedir(), 'mobile-hub-builds')),
  // Global request cap per IP. The default suits a small lab; a busy one
  // (many hosts heartbeating every 10s, several browsers polling, an E2E
  // suite hammering the API) needs it raised, so it must not be hardcoded.
  // Shared secret the device agents present. Required in production (enforced
  // in server.ts); optional in development, where startup warns instead.
  AGENT_TOKEN: z.string().min(16, 'AGENT_TOKEN must be at least 16 characters').optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(200),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  // A separate, tighter bucket for POST /api/auth/register and .../login —
  // brute-force protection backend/CLAUDE.md already calls for. Must be its
  // own config, not a hardcoded literal, for the same reason the global
  // limit above is: an E2E suite or a shared-IP office network legitimately
  // needs a different value than a small lab does. Plain milliseconds, not
  // a duration string like RATE_LIMIT_WINDOW — this one is parsed by a
  // small dedicated limiter (common/auth-rate-limit.ts), not
  // @fastify/rate-limit, so there's no duration-string parser to reuse.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // Per-host cap on concurrent Android MJPEG/H264 captures — unlike iOS
  // simulators (xcrun silently drops frames past 8, a hard platform limit),
  // Android has no such wall; it just degrades: shared adb server, host CPU,
  // and emulator/USB I/O all get worse per additional stream. Default of 3
  // matches the documented streaming-risk guidance (2-4 comfortable before
  // H264 is verified on real hardware) — must be config, same reasoning as
  // every other operational limit here.
  ANDROID_STREAM_CAP: z.coerce.number().int().positive().default(3),
  // Upper bound on one run's test command. Without it a hung runner kept its
  // run `running` forever — the lock TTL eventually freed the device, but the
  // run never ended. 120 matches what a production farm in this domain
  // settled on; a long nightly regression may need it raised.
  EXECUTION_MAX_RUN_MINUTES: z.coerce.number().int().positive().default(120),
  // How many runs may install dependencies at once on this hub. Each npm
  // install peaks at 1.5-3 GB RSS; a reference farm ran out of memory with
  // several in parallel and settled on 3. Runs past the limit wait in the
  // installing stage (cancellable) rather than failing.
  EXECUTION_PREP_CONCURRENCY: z.coerce.number().int().positive().default(3),
  // Who executes runs on this hub, recorded on every run as executor.machineId.
  // Defaults to the hostname, the same default an agent uses for itself.
  HUB_MACHINE_ID: z.string().min(1).default(os.hostname()),
  ORG_CONFIG_PATH: z.string().default(path.join(process.cwd(), '..', 'mobilehub.org.yaml')),
  PROJECT_CONFIG_PATH: z.string().default(path.join(process.cwd(), '..', 'mobilehub.project.yaml')),
});

/**
 * The placeholder values shipped in `.env.example` start with this. They are
 * long enough to pass the length checks above, so a deployment that copies
 * the example verbatim would start in production with a **publicly known**
 * JWT signing key (anyone could mint an admin token) or agent secret.
 */
const PLACEHOLDER_PREFIX = 'replace_with';

/** Exported for testing. */
export const productionSecretsSchema = envSchema.superRefine((e, ctx) => {
  if (e.NODE_ENV !== 'production') return;
  for (const key of ['JWT_SECRET', 'AGENT_TOKEN'] as const) {
    if (e[key]?.startsWith(PLACEHOLDER_PREFIX)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is still the .env.example placeholder — generate a real one (openssl rand -hex 32)`,
      });
    }
  }
});

const parsed = productionSecretsSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
