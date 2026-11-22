import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { env } from '../../../config/env';
import { AutomationConfig } from '../../../config/org-config.schema';
import * as supervisor from '../../../common/process-supervisor';
import { isSuccess, describeOutcome } from '../../../common/process-supervisor';
import { CucumberSuiteProvider } from './cucumber-suite-provider';
import { DiscoveredSuite, SuiteProvider } from './suite-provider';

const PROVIDERS: SuiteProvider[] = [new CucumberSuiteProvider()];
/** Cloning takes seconds; a form re-render must not pay that every time. */
const CACHE_TTL_MS = 5 * 60_000;
const CLONE_TIMEOUT_MS = 120_000;

export class SuiteDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuiteDiscoveryError';
  }
}

/**
 * A branch name safe to hand to git as an argument.
 *
 * The value reaches `git clone --branch <value>`, so a leading `-` would be
 * read as an option rather than a ref; the charset is the conservative subset
 * real branch names use, which also keeps `..`, `@{`, whitespace and control
 * characters (all invalid or meaningful to git) out.
 */
export const branchRefSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/-]+$/, 'Branch may contain only letters, digits, ".", "_", "/" and "-".')
  .refine((b) => !b.startsWith('-'), 'Branch must not start with "-".')
  .refine((b) => !b.includes('..') && !b.includes('//'), 'Branch must not contain ".." or "//".')
  .refine((b) => !b.startsWith('/') && !b.endsWith('/') && !b.endsWith('.lock') && !b.endsWith('.'), {
    message: 'Branch is not a valid git ref name.',
  });

interface CacheEntry {
  at: number;
  suites: DiscoveredSuite[];
}
const cache = new Map<string, CacheEntry>();

/**
 * What a project can actually run, read from its automation repo.
 *
 * Exists because `suite` was free text that selected nothing: a typo produced
 * a run that cloned, installed, started the runner and only then failed with
 * "no suite was found" — minutes spent to reject a string. Discovery moves
 * that answer to before the run.
 *
 * The checkout is kept and refreshed rather than re-cloned per call, and the
 * parsed result is cached briefly on top of that: a dropdown rendering must
 * not cost a network round trip to a git host.
 *
 * `branch` reads suites from that branch, since that is the branch the run
 * will execute; omitted, the repo's default branch is used. Each branch gets
 * its own checkout and cache entry so two branches never overwrite each other.
 * `branch` must already have passed `branchRefSchema`.
 */
export async function discoverSuites(
  projectId: string,
  automation: AutomationConfig,
  options: { refresh?: boolean; branch?: string } = {},
): Promise<DiscoveredSuite[]> {
  if (!automation.repoUrl) {
    throw new SuiteDiscoveryError(
      'This project has no automation.repoUrl configured, so there is no repository to read suites from.',
    );
  }

  const provider = PROVIDERS.find((p) => p.framework === automation.framework);
  if (!provider) {
    throw new SuiteDiscoveryError(
      `No suite discovery is implemented for framework '${automation.framework}'. Enter a suite name manually.`,
    );
  }

  const key = `${projectId}::${automation.repoUrl}::${options.branch ?? ''}`;
  const cached = cache.get(key);
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.suites;

  const repoDir = await ensureCheckout(automation.repoUrl, options.branch);
  const suites = await provider.discover(repoDir, automation);
  cache.set(key, { at: Date.now(), suites });
  return suites;
}

/**
 * A shallow checkout of the automation repo, reused across calls.
 *
 * Lives beside the run cache rather than in a run's workspace: it belongs to
 * no single run, and a workspace is deleted when its run ends. Shallow and
 * single-branch because nothing here needs history — only the current file
 * tree. A named branch gets a checkout of its own (keyed by repo + branch);
 * the default-branch checkout keeps its original location.
 */
async function ensureCheckout(repoUrl: string, branch?: string): Promise<string> {
  const id = branch === undefined ? repoUrl : `${repoUrl}#branch=${branch}`;
  const root = path.join(env.EXECUTIONS_DIR, '.suites');
  const dir = path.join(root, crypto.createHash('sha256').update(id).digest('hex'));

  // Two form renders for the same branch arrive together often enough (two
  // tabs, a refresh mid-load). Without this both would clone into the same
  // directory, or one would pull while the other is still cloning.
  const running = inflight.get(dir);
  if (running) return running;

  const work = checkout(dir, repoUrl, branch).then((d) => {
    // Marks the checkout as used; pruning goes by this, not by git activity.
    const now = new Date();
    fs.utimesSync(d, now, now);
    return d;
  });
  inflight.set(dir, work);
  try {
    return await work;
  } finally {
    inflight.delete(dir);
    pruneStaleCheckouts(root);
  }
}

const inflight = new Map<string, Promise<string>>();
/** A checkout nobody has asked for in this long is a branch that is gone or done. */
export const STALE_CHECKOUT_MS = 14 * 24 * 60 * 60_000;

/**
 * Removes checkouts not used for `STALE_CHECKOUT_MS`.
 *
 * Every branch typed into the form leaves a checkout behind, so without this
 * `.suites` only ever grows. A pruned checkout that turns out to be wanted
 * again is simply re-cloned. Best-effort: a failure here must never fail the
 * discovery call that triggered it.
 */
function pruneStaleCheckouts(root: string): void {
  const cutoff = Date.now() - STALE_CHECKOUT_MS;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const dir = path.join(root, name);
    if (inflight.has(dir)) continue;
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Removed concurrently, or locked by a virus scanner: try again next time.
    }
  }
}

async function checkout(dir: string, repoUrl: string, branch?: string): Promise<string> {
  if (fs.existsSync(path.join(dir, '.git'))) {
    // Best-effort refresh. A fetch failure (offline, credentials expired)
    // leaves the previous checkout in place, which is better than failing the
    // dropdown outright — stale suites still beat none.
    const pull = supervisor.run({ command: 'git', args: ['pull', '--ff-only'], cwd: dir, timeoutMs: CLONE_TIMEOUT_MS });
    await pull.result;
    return dir;
  }

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const clone = supervisor.run({
    command: 'git',
    args: [
      'clone',
      '--depth',
      '1',
      '--single-branch',
      ...(branch === undefined ? [] : ['--branch', branch]),
      '--',
      repoUrl,
      dir,
    ],
    cwd: path.dirname(dir),
    timeoutMs: CLONE_TIMEOUT_MS,
  });
  const outcome = await clone.result;
  if (!isSuccess(outcome)) {
    // Leave nothing half-cloned behind, or the next call will take the
    // "already checked out" branch above and try to pull an empty directory.
    fs.rmSync(dir, { recursive: true, force: true });
    throw new SuiteDiscoveryError(`Could not read the automation repository: ${describeOutcome(outcome)}`);
  }
  return dir;
}
