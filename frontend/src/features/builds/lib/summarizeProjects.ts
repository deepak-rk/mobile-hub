import type { Build } from '../types';

export interface ProjectSummary {
  project: string;
  /** Most recently triggered build for this project — drives the card's headline status + version. */
  latest: Build;
  buildCount: number;
  /** `status === 'ready'` — the backend's actual "artifact present on disk" state. */
  onDiskCount: number;
  purgedCount: number;
}

/**
 * Groups the flat build list into mobile-hub's app catalog — one summary per
 * `project`, the field the backend already has (build.model.ts). There is no
 * separate "app" entity; `project` *is* the app identity here.
 */
export function summarizeProjects(builds: Build[]): ProjectSummary[] {
  const groups = new Map<string, Build[]>();
  for (const build of builds) {
    const list = groups.get(build.project);
    if (list) list.push(build);
    else groups.set(build.project, [build]);
  }

  return Array.from(groups.entries())
    .map(([project, group]) => {
      const sorted = [...group].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return {
        project,
        latest: sorted[0],
        buildCount: group.length,
        onDiskCount: group.filter((b) => b.status === 'ready').length,
        purgedCount: group.filter((b) => b.status === 'purged').length,
      };
    })
    .sort((a, b) => a.project.localeCompare(b.project));
}
