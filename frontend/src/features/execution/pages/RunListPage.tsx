import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, SortingState, useReactTable } from '@tanstack/react-table';
import {
  Button,
  EmptyState,
  Mono,
  Page,
  PageHeader,
  QueryBoundary,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { icons, iconSize } from '@/lib/icons';
import { formatDurationBetween, formatRelative } from 'ts-format-utils';
import { useExecutionRuns } from '../api/execution.api';
import { RunFilterBar } from '../components/RunFilterBar';
import { useRunFilters } from '../hooks/useRunFilters';
import type { ExecutionRun } from '../types';
import styles from './RunListPage.module.css';

const columnHelper = createColumnHelper<ExecutionRun>();

const columns = [
  columnHelper.accessor('status', {
    header: 'Status',
    cell: (info) => <StatusBadge status={info.getValue()} />,
  }),
  columnHelper.accessor('project', {
    header: 'Project',
    cell: (info) => (
      <Link to={`/execution/${info.row.original._id}`} className={styles.link}>
        <span className={styles.project}>{info.getValue()}</span>
      </Link>
    ),
  }),
  columnHelper.accessor('suite', {
    header: 'Suite',
    cell: (info) => <span className={styles.suite}>{info.getValue()}</span>,
  }),
  columnHelper.accessor('branch', {
    header: 'Branch',
  }),
  columnHelper.accessor('deviceUdid', {
    header: 'Device',
    enableSorting: false,
    cell: (info) => <Mono>{info.getValue()}</Mono>,
  }),
  columnHelper.accessor((run) => formatDurationBetween(run.startedAt, run.endedAt), {
    id: 'duration',
    header: 'Duration',
    enableSorting: false,
  }),
  columnHelper.accessor('createdAt', {
    header: 'Created',
    cell: (info) => formatRelative(info.getValue()),
  }),
];

export function RunListPage() {
  const { status, setStatus, project, setProject } = useRunFilters();
  const { data: runs, isPending, error, refetch } = useExecutionRuns({ status, project });
  const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: true }]);
  const data = useMemo(() => runs ?? [], [runs]);
  const filtered = status !== 'all' || project !== '';

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
        title="Execution runs"
        subtitle="Test runs dispatched to devices, newest first."
        actions={
          <Link to="/execution/new">
            <Button variant="primary" size="sm">
              <icons.running size={iconSize.control} aria-hidden="true" />
              Trigger a run
            </Button>
          </Link>
        }
      />

      <RunFilterBar status={status} onStatusChange={setStatus} project={project} onProjectChange={setProject} />

      <QueryBoundary
        isPending={isPending}
        error={error}
        isEmpty={runs?.length === 0}
        onRetry={() => void refetch()}
        empty={
          filtered ? (
            <EmptyState
              icon={icons.execution}
              title="No runs match these filters"
              body="Try a different status or project, or clear the filters to see every run."
            />
          ) : (
            <EmptyState
              icon={icons.execution}
              title="No runs yet"
              body="When a run is triggered it locks a device, executes its suite, and streams stage and log events here in real time."
            />
          )
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
