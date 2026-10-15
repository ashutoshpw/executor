"use client";

import { useMemo, useState } from "react";
import { Button } from "../components/button.tsx";

/** Rows mounted at first and added by each "Show more". The DOM stays bounded for large files. */
export const tableRowsPerPage = 500;

/** The spreadsheet name of a zero-based column: A, B, ... Z, AA, AB, ... */
export const columnName = (index: number): string => {
  let name = "";
  let rest = index;
  while (rest >= 0) {
    name = String.fromCharCode(65 + (rest % 26)) + name;
    rest = Math.floor(rest / 26) - 1;
  }
  return name;
};

/**
 * A read-only grid with a sticky header row and a sticky row-number column, scrolling inside its
 * container. Cells keep to one line and carry their full value as a tooltip. Short rows are padded.
 */
export function PreviewTable({
  header,
  rows,
  rowNumbers,
  label,
  note,
}: {
  /** Column headings; the grid has at least this many columns. */
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** The label of each row in the left column; defaults to 1, 2, 3, ... */
  readonly rowNumbers?: readonly number[];
  readonly label: string;
  /** A line under the grid, for instance that the file was cut short. */
  readonly note?: React.ReactNode;
}) {
  const [shown, setShown] = useState(tableRowsPerPage);
  const columns = useMemo(() => {
    let widest = header.length;
    for (const row of rows) if (row.length > widest) widest = row.length;
    return widest;
  }, [header, rows]);
  const visible = rows.slice(0, shown);
  const cell = "max-w-[28ch] truncate border-b border-r px-3 py-1.5";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <table className="w-max min-w-full border-separate border-spacing-0 text-left text-[12px] tabular-nums">
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky top-0 left-0 z-20 border-b border-r bg-muted px-3 py-1.5 text-right font-normal text-muted-foreground"
              >
                <span className="sr-only">Row</span>
              </th>
              {Array.from({ length: columns }, (_, column) => (
                <th
                  key={column}
                  scope="col"
                  title={header[column] || undefined}
                  className={`sticky top-0 z-10 bg-muted font-medium ${cell}`}
                >
                  {header[column] ?? ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <tr key={index}>
                <th
                  scope="row"
                  data-row-number
                  className="sticky left-0 z-10 border-b border-r bg-muted px-3 py-1.5 text-right font-normal text-muted-foreground"
                >
                  {rowNumbers?.[index] ?? index + 1}
                </th>
                {Array.from({ length: columns }, (_, column) => (
                  <td key={column} title={row[column] || undefined} className={cell}>
                    {row[column] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-2 text-xs text-muted-foreground">
        <span aria-live="polite">
          Showing {visible.length.toLocaleString("en-US")} of {rows.length.toLocaleString("en-US")}{" "}
          rows
        </span>
        {shown < rows.length && (
          <Button
            variant="outline"
            size="xs"
            onClick={() => setShown((count) => count + tableRowsPerPage)}
          >
            Show more
          </Button>
        )}
        {note}
      </div>
    </div>
  );
}
