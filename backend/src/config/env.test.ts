import { describe, it, expect } from 'vitest';
import { productionSecretsSchema } from './env';

/**
 * Regression for a security gap found 2026-11-21. The `.env.example`
 * placeholders are long enough to pass the length checks, so a deployment
 * that copied the example verbatim started in production with a publicly
 * known JWT signing key — anyone could mint an admin token. A production farm
 * in this domain had the related failure (real credentials committed beside
 * placeholder-looking config) as its first recommended fix.
 */
const base = {
  MONGODB_URI: 'mongodb://localhost:27017/x',
  JWT_SECRET: 'a'.repeat(64),
  AGENT_TOKEN: 'b'.repeat(64),
};

describe('production secret validation', () => {
  it('refuses the example JWT secret in production', () => {
    const result = productionSecretsSchema.safeParse({
      ...base,
      NODE_ENV: 'production',
      JWT_SECRET: 'replace_with_32_plus_random_bytes_openssl_rand_hex_32',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.flatten().fieldErrors)).toContain('JWT_SECRET');
  });

  it('refuses the example agent token in production', () => {
    const result = productionSecretsSchema.safeParse({
      ...base,
      NODE_ENV: 'production',
      AGENT_TOKEN: 'replace_with_32_plus_random_bytes',
    });
    expect(result.success).toBe(false);
  });

  it('accepts real secrets in production', () => {
    expect(productionSecretsSchema.safeParse({ ...base, NODE_ENV: 'production' }).success).toBe(true);
  });

  it('leaves development alone, so a fresh clone still boots from the example file', () => {
    expect(
      productionSecretsSchema.safeParse({
        ...base,
        NODE_ENV: 'development',
        JWT_SECRET: 'replace_with_32_plus_random_bytes_openssl_rand_hex_32',
      }).success,
    ).toBe(true);
  });
});
