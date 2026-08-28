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

/** Shared between the pipeline page's Current and History tabs. */
export function RunTable({ runs }: { runs: ExecutionRun[] }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: true }]);

  const table = useReactTable({
    data: runs,
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
