import type { ReactNode } from "react";

/** Number formatting and table primitives shared by the Home and Tasks pages. */
export const count = new Intl.NumberFormat();
export const percent = (rate: number) =>
  `${(rate * 100).toFixed(rate === 1 || rate === 0 ? 0 : 1)}%`;
export const duration = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
export function Tile({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</dd>
    </div>
  );
}

export function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export const headCell = "px-4 py-2 text-left text-xs font-medium text-muted-foreground";
export const numberHead = `${headCell} text-right`;
export const cell = "px-4 py-2.5 text-sm";
export const numberCell = `${cell} text-right tabular-nums`;

export function Table({
  caption,
  children,
}: {
  readonly caption: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-120 border-collapse">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}
