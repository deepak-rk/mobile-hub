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
