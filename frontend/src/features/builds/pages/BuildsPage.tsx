import { useMemo, useState } from 'react';
import { Button, EmptyState, Page, PageHeader, QueryBoundary, useSearchParamsState } from 'react-design-kit';
import { icons } from '@/lib/icons';
import { useBuilds } from '../api/builds.api';
import { BuildDetailDialog } from '../components/BuildDetailDialog';
import { ProjectCatalog } from '../components/ProjectCatalog';
import { ProjectVersionTable } from '../components/ProjectVersionTable';
import { summarizeProjects } from '../lib/summarizeProjects';
import type { Build } from '../types';

/**
 * Builds page — three drill-down levels over the same `GET /builds` data:
 * app catalog (one card per `project`) → per-app version table → build
 * detail. `project` stays URL-synced (guidelines §10's "filters URL-synced"),
 * so a link into a specific app's version table is shareable; the build
 * detail dialog is transient, local state, matching how LockControls'
 * confirm dialog works.
 */
export function BuildsPage() {
  const { data: builds, isPending, error, refetch } = useBuilds();
  const [projectParam, setProjectParam] = useSearchParamsState('project', '');
  const [openBuild, setOpenBuild] = useState<Build | null>(null);

  const data = useMemo(() => builds ?? [], [builds]);
  const projects = useMemo(() => summarizeProjects(data), [data]);
  const selectedProject = projectParam || null;
  const projectBuilds = useMemo(
    () => (selectedProject ? data.filter((build) => build.project === selectedProject) : []),
    [data, selectedProject],
  );

  return (
    <Page>
      <PageHeader
        title={selectedProject ?? 'Builds'}
        subtitle={
          selectedProject
            ? `${projectBuilds.length} build${projectBuilds.length === 1 ? '' : 's'} fetched for this project.`
            : 'Artifacts fetched by the platform, grouped by project. Every build is checksummed before it is marked ready.'
        }
        actions={
          selectedProject ? (
            <Button size="sm" variant="ghost" onClick={() => setProjectParam('')}>
              Back to all projects
            </Button>
          ) : undefined
        }
      />

      <QueryBoundary
        isPending={isPending}
        error={error}
        isEmpty={data.length === 0}
        onRetry={() => void refetch()}
        empty={
          <EmptyState
            icon={icons.build}
            title="No builds yet"
            body="Trigger a fetch against a configured build provider and the artifact will be downloaded, checksummed, and listed here."
          />
        }
      >
        {selectedProject ? (
          projectBuilds.length > 0 ? (
            <ProjectVersionTable builds={projectBuilds} onView={setOpenBuild} />
          ) : (
            <EmptyState
              icon={icons.build}
              title="No builds for this project"
              body="It may have been purged entirely, or the link points at a project name that no longer has any builds."
              action={{ label: 'Back to all projects', onClick: () => setProjectParam('') }}
            />
          )
        ) : (
          <ProjectCatalog projects={projects} onSelect={setProjectParam} />
        )}
      </QueryBoundary>

      <BuildDetailDialog build={openBuild} onClose={() => setOpenBuild(null)} />
    </Page>
  );
}
