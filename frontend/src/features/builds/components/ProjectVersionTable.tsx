import { useMemo, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { Button, Mono, ProgressBar, Table, Tbody, Td, Th, Thead, Tr } from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatBytes, formatRelative, shortId } from 'ts-format-utils';
import type { Build } from '../types';
import styles from './ProjectVersionTable.module.css';

/**
 * Builds move downloading → validating → ready|corrupt|purged. The backend
 * fetches synchronously today (no per-byte progress events yet), so the bar
 * shows indeterminate-ish stage progress rather than inventing a byte count.
 * Mirrors the stage logic the flat table used before this restructure.
 */
function buildProgress(status: Build['status']): { value: number; complete: boolean } | null {
  if (status === 'downloading') return { value: 45, complete: false };
  if (status === 'validating') return { value: 100, complete: false };
  return null;
}

const columnHelper = createColumnHelper<Build>();

function makeColumns(onView: (build: Build) => void) {
  return [
    columnHelper.accessor('version', {
      header: 'Version',
      cell: (info) => <Mono>{info.getValue()}</Mono>,
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
      cell: (info) =>
        info.getValue() ? <Mono>{shortId(info.getValue()!)}</Mono> : <span className={styles.dash}>—</span>,
    }),
    columnHelper.accessor('fetchedAt', {
      header: 'Fetched',
      cell: (info) => formatRelative(info.getValue()),
    }),
    columnHelper.accessor('artifactPath', {
      header: 'On disk at',
      enableSorting: false,
      cell: (info) =>
        info.getValue() ? <Mono>{shortId(info.getValue()!)}</Mono> : <span className={styles.dash}>—</span>,
    }),
    columnHelper.display({
      id: 'actions',
      header: 'Actions',
      cell: (info) => (
        <Button size="sm" variant="ghost" onClick={() => onView(info.row.original)}>
          View
        </Button>
      ),
    }),
  ];
}

/**
 * The per-app version table (drill-down level 2). Same real `Build` fields
 * the old flat table showed, scoped to one `project`, reusing the shared
 * themed `Table` + TanStack sorting rather than rebuilding table mechanics.
 */
export function ProjectVersionTable({ builds, onView }: { builds: Build[]; onView: (build: Build) => void }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const columns = useMemo(() => makeColumns(onView), [onView]);

  const table = useReactTable({
    data: builds,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
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
  );
}
