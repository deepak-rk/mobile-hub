import { Card, CardBody, Grid, Meta, MetaSep, Mono } from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatRelative } from 'ts-format-utils';
import type { ProjectSummary } from '../lib/summarizeProjects';
import styles from './ProjectCatalog.module.css';

export function ProjectCatalog({
  projects,
  onSelect,
}: {
  projects: ProjectSummary[];
  onSelect: (project: string) => void;
}) {
  return (
    <Grid>
      {projects.map((summary) => (
        <Card key={summary.project} interactive>
          <CardBody>
            <div className={styles.head}>
              <button type="button" className={styles.name} onClick={() => onSelect(summary.project)}>
                {summary.project}
              </button>
              <StatusBadge status={summary.latest.status} />
            </div>

            <Meta>
              <span>{summary.latest.platform === 'ios' ? 'iOS' : 'Android'}</span>
              <MetaSep />
              <span>
                Latest <Mono>{summary.latest.version}</Mono>
              </span>
            </Meta>

            <div className={styles.footer}>
              <span>
                {summary.buildCount} build{summary.buildCount === 1 ? '' : 's'} · {summary.onDiskCount} on disk
                {summary.purgedCount > 0 ? ` · ${summary.purgedCount} purged` : ''}
              </span>
              <span className={styles.seen}>Last build {formatRelative(summary.latest.createdAt)}</span>
            </div>
          </CardBody>
        </Card>
      ))}
    </Grid>
  );
}
