import { Link } from "@tanstack/react-router";
import { Fragment, useState, type ReactNode } from "react";
import type { UsageRange, UsageReport } from "@executor-js/hosted-server/usage";
import { Button } from "@executor-js/ui/components/button";
import { LocalTime } from "@executor-js/ui/components/local-time";
import { QueryView } from "@executor-js/ui/dashboard/context";
import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { PageFrame, PageHeader } from "@executor-js/ui/dashboard/page";
import { productTitle, useDocumentTitle } from "@executor-js/ui/hooks/document-title";
import { usageAtom } from "../../contracts/usage.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";

const homeTitle = "Home";
const ranges = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
] as const satisfies readonly { readonly value: UsageRange; readonly label: string }[];

/** The range the page shows when the address names none. */
export const defaultRange = "7d" as const satisfies UsageRange;

const count = new Intl.NumberFormat();
const percent = (rate: number) => `${(rate * 100).toFixed(rate === 1 || rate === 0 ? 0 : 1)}%`;
const duration = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const formatDay = (date: string) => dayFormat.format(new Date(`${date}T00:00:00Z`));

/** Who is using the connected apps, and which apps and tools they use most. */
export function HomePage({
  range = defaultRange,
  onRangeChange,
}: {
  readonly range?: UsageRange | undefined;
  readonly onRangeChange: (range: UsageRange) => void;
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  useDocumentTitle(productTitle(homeTitle));
  return (
    <PageFrame>
      <PageHeader
        title={homeTitle}
        description="Tool calls made by your connected agents, schedules and workflows."
      >
        <div role="group" aria-label="Time range" className="flex items-center gap-1.5">
          {ranges.map((item) => (
            <Button
              key={item.value}
              size="sm"
              variant={item.value === range ? "default" : "outline"}
              aria-pressed={item.value === range}
              onClick={() => onRangeChange(item.value)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </PageHeader>
      <QueryView query={usageAtom(organization, range)} Failure={HostedFailure}>
        {(report) => <Report report={report} organizationSlug={organizationSlug} />}
      </QueryView>
    </PageFrame>
  );
}

function Report({
  report,
  organizationSlug,
}: {
  readonly report: UsageReport;
  readonly organizationSlug: string;
}) {
  if (!report.available)
    return (
      <EmptyState title="Usage insights are not available on this deployment">
        This deployment does not keep tool call records.
      </EmptyState>
    );
  if (report.totals.calls === 0)
    return (
      <EmptyState
        title="No tool calls yet"
        action={
          <Button size="sm" asChild>
            <Link to="/org/$organizationSlug/connect" params={{ organizationSlug }}>
              Connect an agent
            </Link>
          </Button>
        }
      >
        Once a connected agent calls a tool, its usage appears here.
      </EmptyState>
    );
  const { totals } = report;
  return (
    <div className="grid gap-6">
      {report.scope === "self" && (
        <p className="text-[13px] text-muted-foreground">
          These numbers are your own usage. Organization administrators see everyone&apos;s.
        </p>
      )}
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3">
        <Tile label="Tool calls" value={count.format(totals.calls)} />
        <Tile label="Success rate" value={percent(totals.successRate)} />
        <Tile label="Active agents" value={count.format(totals.activeAgents)} />
        <Tile label="Active apps" value={count.format(totals.activeApps)} />
        <Tile label="Avg duration" value={duration(totals.avgDurationMs)} />
      </dl>
      <Section title="Calls per day">
        <DailyChart days={report.daily} />
      </Section>
      <Section title="Most used apps">
        <AppsTable apps={report.topApps} />
      </Section>
      <Section title="Agents by tool calls">
        <AgentsTable agents={report.agents} />
      </Section>
      {report.failureTypes.length > 0 && (
        <Section title="Failure types">
          <ul className="divide-y rounded-lg border">
            {report.failureTypes.map((item) => (
              <li
                key={item.errorType}
                className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm"
              >
                <span className="min-w-0 break-words font-mono text-[13px]">{item.errorType}</span>
                <span className="tabular-nums text-muted-foreground">
                  {count.format(item.count)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Tile({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</dd>
    </div>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const headCell = "px-4 py-2 text-left text-xs font-medium text-muted-foreground";
const numberHead = `${headCell} text-right`;
const cell = "px-4 py-2.5 text-sm";
const numberCell = `${cell} text-right tabular-nums`;

function Table({ caption, children }: { readonly caption: string; readonly children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-120 border-collapse">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

function AppsTable({ apps }: { readonly apps: UsageReport["topApps"] }) {
  return (
    <Table caption="Most used apps">
      <thead className="border-b">
        <tr>
          <th scope="col" className={headCell}>
            App
          </th>
          <th scope="col" className={numberHead}>
            Calls
          </th>
          <th scope="col" className={numberHead}>
            Failures
          </th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {apps.map((app) => (
          <tr key={app.appId}>
            <th scope="row" className={`${cell} text-left font-medium break-words`}>
              {app.appName ?? app.appId}
            </th>
            <td className={numberCell}>{count.format(app.calls)}</td>
            <td className={numberCell}>{count.format(app.failures)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function AgentsTable({ agents }: { readonly agents: UsageReport["agents"] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <Table caption="Agents by tool calls">
      <thead className="border-b">
        <tr>
          <th scope="col" className={headCell}>
            Agent
          </th>
          <th scope="col" className={numberHead}>
            Calls
          </th>
          <th scope="col" className={numberHead}>
            Failures
          </th>
          <th scope="col" className={numberHead}>
            Last used
          </th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {agents.map((agent) => {
          const expanded = open.has(agent.agentKey);
          const panel = `agent-tools-${agent.agentKey}`;
          return (
            <Fragment key={agent.agentKey}>
              <tr>
                <th scope="row" className={`${cell} text-left font-medium`}>
                  <button
                    type="button"
                    className="flex min-h-6 max-w-full items-center gap-2 text-left break-words"
                    aria-expanded={expanded}
                    aria-controls={panel}
                    onClick={() => toggle(agent.agentKey)}
                  >
                    <span aria-hidden className="text-muted-foreground">
                      {expanded ? "▾" : "▸"}
                    </span>
                    {agent.label}
                  </button>
                </th>
                <td className={numberCell}>{count.format(agent.calls)}</td>
                <td className={numberCell}>{count.format(agent.failures)}</td>
                <td className={`${numberCell} text-muted-foreground`}>
                  <LocalTime value={new Date(agent.lastUsedAt)} />
                </td>
              </tr>
              {expanded && (
                <tr id={panel}>
                  <td colSpan={4} className="bg-muted/30 px-4 py-3">
                    {agent.topTools.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No tools recorded.</p>
                    ) : (
                      <ul className="grid gap-1.5">
                        {agent.topTools.map((tool) => (
                          <li
                            key={`${tool.appId}/${tool.toolName}`}
                            className="flex items-center justify-between gap-4 text-[13px]"
                          >
                            <span className="min-w-0 break-words font-mono">
                              {tool.appId} · {tool.toolName}
                            </span>
                            <span className="tabular-nums text-muted-foreground">
                              {count.format(tool.calls)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </Table>
  );
}

/** Stacked bars: successful calls in the accent colour, failures in the destructive one. */
function DailyChart({ days }: { readonly days: UsageReport["daily"] }) {
  const width = 600;
  const height = 160;
  const top = 8;
  const bottom = 22;
  const plot = height - top - bottom;
  const max = Math.max(1, ...days.map((day) => day.calls));
  const slot = width / Math.max(1, days.length);
  const bar = Math.max(2, slot * 0.7);
  const total = days.reduce((sum, day) => sum + day.calls, 0);
  const failed = days.reduce((sum, day) => sum + day.failures, 0);
  const summary = `Tool calls per day: ${count.format(total)} calls, ${count.format(failed)} failures, over ${days.length} days.`;
  const labelEvery = Math.ceil(days.length / 6);
  return (
    <div className="rounded-lg border p-4">
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
      >
        <line
          x1={0}
          x2={width}
          y1={top + plot}
          y2={top + plot}
          className="stroke-border"
          strokeWidth={1}
        />
        {days.map((day, index) => {
          const x = index * slot + (slot - bar) / 2;
          const callsHeight = (day.calls / max) * plot;
          const failureHeight = (day.failures / max) * plot;
          return (
            <g key={day.date}>
              <title>{`${formatDay(day.date)}: ${day.calls} calls, ${day.failures} failures`}</title>
              <rect
                x={x}
                y={top + plot - callsHeight}
                width={bar}
                height={callsHeight - failureHeight}
                rx={1.5}
                className="fill-primary"
              />
              <rect
                x={x}
                y={top + plot - failureHeight}
                width={bar}
                height={failureHeight}
                className="fill-destructive"
              />
              {index % labelEvery === 0 && (
                <text
                  x={x + bar / 2}
                  y={height - 6}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {formatDay(day.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-sm bg-primary" />
          Succeeded
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-sm bg-destructive" />
          Failed
        </span>
        <span>Peak {count.format(max)} calls in a day</span>
      </p>
    </div>
  );
}
