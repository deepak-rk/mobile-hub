import * as supervisor from '../../common/process-supervisor';
import { isSuccess, describeOutcome } from '../../common/process-supervisor';

/** A form re-render must not pay a network round trip to the git host every time. */
const CACHE_TTL_MS = 5 * 60_000;
const LS_REMOTE_TIMEOUT_MS = 20_000;

export class BranchDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BranchDiscoveryError';
  }
}

export interface BranchList {
  branches: string[];
  /** The remote's HEAD branch, or null when the remote does not say (rare; some servers omit it). */
  defaultBranch: string | null;
}

interface CacheEntry extends BranchList {
  at: number;
}
const cache = new Map<string, CacheEntry>();

/**
 * Real branch names from a project's automation repo.
 *
 * `git ls-remote --heads` rather than a vendor API (GitHub/GitLab Graph API):
 * it works against any git remote regardless of host, needs no additional
 * credentials beyond whatever the repo clone already needs, and needs no
 * local checkout at all — unlike suite discovery (`suites.service.ts`),
 * this only asks the remote what refs exist, it never reads file content.
 *
 * `--symref HEAD` also names the remote's default branch, so the trigger form
 * can start on it instead of assuming `main` (a repo on `master` or `develop`
 * otherwise opened the form on a branch that does not exist).
 */
export async function discoverBranches(repoUrl: string, options: { refresh?: boolean } = {}): Promise<BranchList> {
  const cached = cache.get(repoUrl);
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { branches: cached.branches, defaultBranch: cached.defaultBranch };
  }

  const chunks: Buffer[] = [];
  const ls = supervisor.run({
    command: 'git',
    args: ['ls-remote', '--symref', repoUrl, 'HEAD', 'refs/heads/*'],
    cwd: process.cwd(),
    timeoutMs: LS_REMOTE_TIMEOUT_MS,
    onStdout: (chunk) => chunks.push(chunk),
  });
  const outcome = await ls.result;
  if (!isSuccess(outcome)) {
    throw new BranchDiscoveryError(`Could not list branches: ${describeOutcome(outcome)}`);
  }

  const stdout = Buffer.concat(chunks).toString('utf8');
  const result = { branches: parseLsRemoteHeads(stdout), defaultBranch: parseDefaultBranch(stdout) };
  cache.set(repoUrl, { at: Date.now(), ...result });
  return result;
}

/**
 * Reads the `ref: refs/heads/<name>\tHEAD` line `--symref` prints. Exported for
 * testing, like `parseLsRemoteHeads`.
 */
export function parseDefaultBranch(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const [ref, name] = line.trim().split('\t');
    if (name === 'HEAD' && ref?.startsWith('ref: refs/heads/')) return ref.slice('ref: refs/heads/'.length);
  }
  return null;
}

/**
 * Parses `git ls-remote --heads` output — one `<sha>\trefs/heads/<name>` line
 * per branch — into plain branch names, alphabetized for a stable dropdown
 * order. Exported for testing: this is pure and is the part that actually
 * breaks if git's output format is ever assumed wrong.
 */
export function parseLsRemoteHeads(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t')[1])
    .filter((ref): ref is string => Boolean(ref) && ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length))
    .sort((a, b) => a.localeCompare(b));
}
