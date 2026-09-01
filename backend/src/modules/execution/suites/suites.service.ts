import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
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
 */
export async function discoverSuites(
  projectId: string,
  automation: AutomationConfig,
  options: { refresh?: boolean } = {},
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

  const key = `${projectId}::${automation.repoUrl}`;
  const cached = cache.get(key);
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.suites;

  const repoDir = await ensureCheckout(automation.repoUrl);
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
 * tree.
 */
async function ensureCheckout(repoUrl: string): Promise<string> {
  const dir = path.join(env.EXECUTIONS_DIR, '.suites', crypto.createHash('sha256').update(repoUrl).digest('hex'));

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
    args: ['clone', '--depth', '1', '--single-branch', repoUrl, dir],
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
