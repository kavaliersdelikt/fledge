"use client";

import { useMemo } from "react";
import {
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { ReactNode } from "react";

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

export type DataColumn<T extends RowData> = {
  id: string;
  header: string;
  value: (row: T) => string | number | null | undefined;
  render?: (row: T) => ReactNode;
  sortable?: boolean;
  className?: string;
};

export default function DataTable<T extends RowData>({
  data,
  columns,
  empty = "No entries found.",
  rowKey,
}: {
  data: T[];
  columns: DataColumn<T>[];
  empty?: ReactNode;
  rowKey?: (row: T) => string;
}) {
  const defs = useMemo(
    () =>
      columns.map((column) => ({
        id: column.id,
        header: column.header,
        accessorFn: column.value,
        enableSorting: column.sortable !== false,
        cell: ({ row, getValue }: { row: { original: T }; getValue: () => unknown }) =>
          column.render ? column.render(row.original) : String(getValue() ?? "—"),
      })) as ColumnDef<typeof features, T>[],
    [columns],
  );
  const table = useTable({
    features,
    columns: defs,
    data,
    getRowId: rowKey,
  });
  const rows = table.getRowModel().rows;

  if (!rows.length) return <div className="table-empty">{empty}</div>;

  return (
    <div className="table-wrap data-table-wrap">
      <table className="data-table">
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => {
                const column = columns.find((candidate) => candidate.id === header.column.id);
                const sorted = header.column.getIsSorted();
                return (
                  <th key={header.id} className={column?.className}>
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <button
                        type="button"
                        className="table-sort"
                        onClick={() => header.column.toggleSorting()}
                        aria-label={`Sort by ${column?.header || header.column.id}`}
                      >
                        <table.FlexRender header={header} />
                        {sorted === "asc" ? <ArrowUp size={12} /> : sorted === "desc" ? <ArrowDown size={12} /> : <ArrowUpDown size={12} />}
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {row.getAllCells().map((cell) => {
                const column = columns.find((candidate) => candidate.id === cell.column.id);
                return (
                  <td key={cell.id} className={column?.className}>
                    <table.FlexRender cell={cell} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
