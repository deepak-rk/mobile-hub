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
  STREAM_WS_PORT: z.coerce.number().int().positive().default(3001),
  MACHINE_ID: z.string().optional(),
  EXECUTIONS_DIR: z.string().default(path.join(os.homedir(), 'mobile-hub-executions')),
  BUILDS_DIR: z.string().default(path.join(os.homedir(), 'mobile-hub-builds')),
  // Global request cap per IP. The default suits a small lab; a busy one
  // (many hosts heartbeating every 10s, several browsers polling, an E2E
  // suite hammering the API) needs it raised, so it must not be hardcoded.
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(200),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  ORG_CONFIG_PATH: z.string().default(path.join(process.cwd(), '..', 'mobilehub.org.yaml')),
  PROJECT_CONFIG_PATH: z.string().default(path.join(process.cwd(), '..', 'mobilehub.project.yaml')),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
