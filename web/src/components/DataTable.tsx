"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp } from "lucide-react";
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
  align?: "end";
  /** Hide on narrow screens. */
  optional?: boolean;
  width?: string;
};

export default function DataTable<T extends RowData>({
  data,
  columns,
  empty = "Nothing here yet.",
  rowKey,
  rowHref,
}: {
  data: T[];
  columns: DataColumn<T>[];
  empty?: ReactNode;
  rowKey?: (row: T) => string;
  /** Makes the whole row navigate; the first cell should still hold a real link. */
  rowHref?: (row: T) => string;
}) {
  const router = useRouter();
  const defs = useMemo(
    () =>
      columns.map((column) => ({
        id: column.id,
        header: column.header,
        accessorFn: column.value,
        enableSorting: column.sortable !== false && !!column.header,
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
  const byId = (id: string) => columns.find((c) => c.id === id);
  const cls = (c?: DataColumn<T>) =>
    [c?.align === "end" ? "is-end" : "", c?.optional ? "is-optional" : ""].filter(Boolean).join(" ") || undefined;

  if (!rows.length) return <div className="table-empty">{empty}</div>;

  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => {
                const column = byId(header.column.id);
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    className={cls(column)}
                    style={column?.width ? { width: column.width } : undefined}
                    aria-sort={sorted ? (sorted === "asc" ? "ascending" : "descending") : undefined}
                  >
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <button
                        type="button"
                        className="table__sort"
                        onClick={() => header.column.toggleSorting()}
                      >
                        <table.FlexRender header={header} />
                        {sorted === "asc" ? <ArrowUp /> : sorted === "desc" ? <ArrowDown /> : null}
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
          {rows.map((row, index) => {
            const href = rowHref?.(row.original);
            return (
              <tr
                key={row.id}
                style={{ ["--i" as string]: index }}
                className={href ? "is-link" : undefined}
                onClick={
                  href
                    ? (e) => {
                        const target = e.target as HTMLElement;
                        if (target.closest("a,button,input,select,textarea")) return;
                        router.push(href);
                      }
                    : undefined
                }
              >
                {row.getAllCells().map((cell) => (
                  <td key={cell.id} className={cls(byId(cell.column.id))}>
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
