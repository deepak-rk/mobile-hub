import { useMemo, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from '@tanstack/react-table';
import {
  EmptyState,
  Mono,
  Page,
  PageHeader,
  ProgressBar,
  QueryBoundary,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons } from '@/lib/icons';
import { formatBytes, formatRelative, shortId } from 'ts-format-utils';
import { useBuilds } from '../api/builds.api';
import type { Build } from '../types';
import styles from './BuildsPage.module.css';

/**
 * Builds move downloading → validating → ready|corrupt. The backend fetches
 * synchronously today (no per-byte progress events yet), so the bar shows
 * indeterminate-ish stage progress rather than inventing a byte count.
 */
function buildProgress(status: Build['status']): { value: number; complete: boolean } | null {
  if (status === 'downloading') return { value: 45, complete: false };
  if (status === 'validating') return { value: 100, complete: false };
  return null;
}

const columnHelper = createColumnHelper<Build>();

const columns = [
  columnHelper.accessor('project', {
    header: 'Project',
    cell: (info) => <span className={styles.project}>{info.getValue()}</span>,
  }),
  columnHelper.accessor('version', {
    header: 'Version',
  }),
  columnHelper.accessor('platform', {
    header: 'Platform',
    cell: (info) => (info.getValue() === 'ios' ? 'iOS' : 'Android'),
  }),
  columnHelper.accessor('status', {
    header: 'Status',
    cell: (info) => {
      const build = info.row.original;
      const progress = buildProgress(build.status);
      return (
        <div className={styles.statusCell}>
          <StatusBadge status={build.status} />
          {progress ? (
            <ProgressBar
              value={progress.value}
              complete={progress.complete}
              label={build.status === 'validating' ? 'Verifying checksum…' : 'Downloading…'}
            />
          ) : null}
          {build.status === 'corrupt' ? (
            <p className={styles.error}>Integrity check failed — re-trigger the fetch to try again.</p>
          ) : null}
        </div>
      );
    },
  }),
  columnHelper.accessor('sizeBytes', {
    header: 'Size',
    cell: (info) => formatBytes(info.getValue()),
    sortingFn: 'basic',
  }),
  columnHelper.accessor('checksum', {
    header: 'sha256',
    enableSorting: false,
    cell: (info) => (info.getValue() ? <Mono>{shortId(info.getValue()!)}</Mono> : <span className={styles.dash}>—</span>),
  }),
  columnHelper.accessor('createdAt', {
    header: 'Created',
    cell: (info) => formatRelative(info.getValue()),
  }),
];

export function BuildsPage() {
  const { data: builds, isPending, error, refetch } = useBuilds();
  const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: true }]);
  const data = useMemo(() => builds ?? [], [builds]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <Page>
      <PageHeader
        title="Builds"
        subtitle="Artifacts fetched by the platform. Every build is checksummed before it is marked ready."
      />

      <QueryBoundary
        isPending={isPending}
        error={error}
        isEmpty={builds?.length === 0}
        onRetry={() => void refetch()}
        empty={
          <EmptyState
            icon={icons.build}
            title="No builds yet"
            body="Trigger a fetch against a configured build provider and the artifact will be downloaded, checksummed, and listed here."
          />
        }
      >
        <Table>
          <Thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <Tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <Th
                    key={header.id}
                    onSort={header.column.getCanSort() ? () => header.column.toggleSorting() : undefined}
                    sort={header.column.getIsSorted() || false}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </Th>
                ))}
              </Tr>
            ))}
          </Thead>
          <Tbody>
            {table.getRowModel().rows.map((row) => (
              <Tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <Td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Td>
                ))}
              </Tr>
            ))}
          </Tbody>
        </Table>
      </QueryBoundary>
    </Page>
  );
}
