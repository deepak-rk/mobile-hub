import { useState } from 'react';
import { Link } from 'react-router-dom';
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, SortingState, useReactTable } from '@tanstack/react-table';
import { Mono, Table, Tbody, Td, Th, Thead, Tr } from 'react-design-kit';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatDurationBetween, formatRelative } from 'ts-format-utils';
import type { ExecutionRun } from '../types';
import styles from './RunTable.module.css';

const columnHelper = createColumnHelper<ExecutionRun>();

const columns = [
  columnHelper.accessor('status', {
    header: 'Status',
    cell: (info) => {
      const run = info.row.original;
      return (
        <div className={styles.statusCell}>
          <StatusBadge status={info.getValue()} />
          {/* Position is only ever meaningful while still queued — once a run
              starts, "waiting" no longer describes it. */}
          {run.status === 'queued' && run.queuePosition !== null ? (
            <span className={styles.queueNote} title={`Waiting for device ${run.deviceUdid}`}>
              #{run.queuePosition} waiting for device
            </span>
          ) : null}
        </div>
      );
    },
  }),
  columnHelper.accessor('project', {
    header: 'Project',
    cell: (info) => (
      <Link to={`/execution/${info.row.original._id}`} className={styles.link}>
        <span className={`${styles.project} ${styles.truncate}`} title={info.getValue()}>
          {info.getValue()}
        </span>
      </Link>
    ),
  }),
  columnHelper.accessor('suite', {
    header: 'Suite',
    cell: (info) => (
      <span className={styles.suite} title={info.getValue()}>
        {info.getValue()}
      </span>
    ),
  }),
  columnHelper.accessor('branch', {
    header: 'Branch',
    cell: (info) => (
      <span className={styles.truncate} title={info.getValue()}>
        {info.getValue()}
      </span>
    ),
  }),
  columnHelper.accessor('deviceUdid', {
    header: 'Device',
    enableSorting: false,
    cell: (info) => (
      <Mono className={styles.truncate} title={info.getValue()}>
        {info.getValue()}
      </Mono>
    ),
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

export interface RunSelection {
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[], on: boolean) => void;
}

/**
 * Shared between the pipeline page's Current and History tabs. `selection`
 * adds a checkbox column for bulk actions; left out for callers without one.
 */
export function RunTable({ runs, selection }: { runs: ExecutionRun[]; selection?: RunSelection }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: true }]);

  const allIds = runs.map((r) => r._id);
  const allOn = selection ? allIds.length > 0 && allIds.every((id) => selection.selected.has(id)) : false;
  const selectColumn = selection
    ? [
        columnHelper.display({
          id: 'select',
          header: () => (
            <input
              type="checkbox"
              aria-label="Select all runs"
              checked={allOn}
              onChange={() => selection.onToggleAll(allIds, !allOn)}
            />
          ),
          cell: (info) => (
            <input
              type="checkbox"
              aria-label={`Select run ${info.row.original._id}`}
              checked={selection.selected.has(info.row.original._id)}
              onChange={() => selection.onToggle(info.row.original._id)}
            />
          ),
        }),
      ]
    : [];

  const table = useReactTable({
    data: runs,
    columns: [...selectColumn, ...columns],
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
