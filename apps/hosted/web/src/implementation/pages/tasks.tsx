import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Option } from "effect";
import { Link } from "@tanstack/react-router";
import { Fragment, useState, type ReactNode } from "react";
import type { UsageRange } from "@executor-js/hosted-server/usage";
import type {
  TaskCall,
  TaskCallFile,
  TaskDetail,
  TaskSummary,
} from "@executor-js/hosted-server/tasks";
import { Button } from "@executor-js/ui/components/button";
import { LocalTime } from "@executor-js/ui/components/local-time";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { QueryView } from "@executor-js/ui/dashboard/context";
import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { PageFrame, PageHeader } from "@executor-js/ui/dashboard/page";
import { productTitle, useDocumentTitle } from "@executor-js/ui/hooks/document-title";
import { taskAtom, tasksAtom } from "../../contracts/tasks.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";
import {
  cell,
  count,
  duration,
  headCell,
  numberCell,
  numberHead,
  Section,
  Table,
  Tile,
} from "../components/usage-parts.tsx";
import { defaultRange, ranges } from "./home.tsx";
import { formatFileSize } from "./files.tsx";

const tasksTitle = "Tasks";
const kindLabel = { task: "Task", session: "Session", run: "Run" } as const;

/** The tool calls agents made for each task, for organization owners and admins. */
export function TasksPage({
  range = defaultRange,
  task,
  onRangeChange,
  onTaskChange,
}: {
  readonly range?: UsageRange | undefined;
  readonly task?: string | undefined;
  readonly onRangeChange: (range: UsageRange) => void;
  readonly onTaskChange: (task: string | undefined) => void;
}) {
  const { role } = useOrganizationRoute();
  useDocumentTitle(productTitle(tasksTitle));
  const header = (
    <PageHeader
      title={tasksTitle}
      description="What your agents did for each task, call by call, in the order they made them."
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
  );
  if (role === undefined)
    return (
      <PageFrame>
        {header}
        <div role="status" className="grid gap-2" aria-label="Loading tasks">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </PageFrame>
    );
  if (role === "member")
    return (
      <PageFrame>
        <PageHeader title={tasksTitle} />
        <EmptyState title="Only organization owners and admins can view tasks">
          Task records can include other people&apos;s work. Ask an owner or admin for access.
        </EmptyState>
      </PageFrame>
    );
  return (
    <PageFrame>
      {header}
      {task === undefined ? (
        <TaskList range={range} open={onTaskChange} />
      ) : (
        <TaskView range={range} taskKey={task} back={() => onTaskChange(undefined)} />
      )}
    </PageFrame>
  );
}

function TaskList({
  range,
  open,
}: {
  readonly range: UsageRange;
  readonly open: (key: string) => void;
}) {
  const { organization } = useOrganizationRoute();
  // The cursors of the pages shown so far; the first page has none. A new range starts again.
  const [pages, setPages] = useState<{
    readonly range: UsageRange;
    readonly afters: ReadonlyArray<string | undefined>;
  }>({ range, afters: [undefined] });
  const afters = pages.range === range ? pages.afters : [undefined];
  const first = useAtomValue(tasksAtom(organization, range, undefined));
  const refresh = useAtomRefresh(tasksAtom(organization, range, undefined));
  const page = AsyncResult.value(first);
  if (Option.isNone(page))
    return AsyncResult.isFailure(first) ? (
      <HostedFailure cause={first.cause} retry={refresh} />
    ) : (
      <div role="status" className="grid gap-2" aria-label="Loading tasks">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  if (!page.value.available)
    return (
      <EmptyState title="Task insights are not available on this deployment">
        This deployment does not keep tool call records.
      </EmptyState>
    );
  if (page.value.tasks.length === 0)
    return (
      <EmptyState title="No tasks in this range">
        Agents group their calls into a task by sending a task ID with each tool call.
      </EmptyState>
    );
  return (
    <Table caption="Tasks">
      <thead className="border-b">
        <tr>
          <th scope="col" className={headCell}>
            Task
          </th>
          <th scope="col" className={headCell}>
            Apps
          </th>
          <th scope="col" className={numberHead}>
            Calls
          </th>
          <th scope="col" className={numberHead}>
            Failures
          </th>
          <th scope="col" className={numberHead}>
            Duration
          </th>
          <th scope="col" className={numberHead}>
            Last call
          </th>
        </tr>
      </thead>
      {afters.map((after, index) => (
        <TaskRows
          key={after ?? "first"}
          range={range}
          after={after}
          last={index === afters.length - 1}
          open={open}
          more={(next) => setPages({ range, afters: [...afters, next] })}
        />
      ))}
    </Table>
  );
}

function TaskRows({
  range,
  after,
  last,
  open,
  more,
}: {
  readonly range: UsageRange;
  readonly after: string | undefined;
  readonly last: boolean;
  readonly open: (key: string) => void;
  readonly more: (next: string) => void;
}) {
  const { organization } = useOrganizationRoute();
  const result = useAtomValue(tasksAtom(organization, range, after));
  const page = AsyncResult.value(result);
  if (Option.isNone(page))
    return (
      <tbody>
        <tr>
          <td colSpan={6} className={cell}>
            {AsyncResult.isFailure(result) ? (
              <HostedFailure cause={result.cause} />
            ) : (
              <span role="status" className="text-muted-foreground">
                Loading tasks…
              </span>
            )}
          </td>
        </tr>
      </tbody>
    );
  const { tasks, next } = page.value;
  return (
    <tbody className="divide-y">
      {tasks.map((item) => (
        <tr key={item.key}>
          <th scope="row" className={`${cell} text-left font-medium`}>
            <button
              type="button"
              className="min-h-6 max-w-full text-left break-words underline-offset-2 hover:underline"
              onClick={() => open(item.key)}
            >
              <span className="font-mono text-[13px]">{item.label}</span>
            </button>
            {item.kind !== "task" && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {kindLabel[item.kind]} without a task ID
              </span>
            )}
          </th>
          <td className={`${cell} text-muted-foreground`}>{appNames(item)}</td>
          <td className={numberCell}>{count.format(item.calls)}</td>
          <td className={numberCell}>{count.format(item.failures)}</td>
          <td className={numberCell}>{duration(item.totalDurationMs)}</td>
          <td className={`${numberCell} text-muted-foreground`}>
            <LocalTime value={new Date(item.lastAt)} />
          </td>
        </tr>
      ))}
      {last && next !== null && (
        <tr>
          <td colSpan={6} className="px-4 py-2.5 text-center">
            <Button variant="outline" size="sm" onClick={() => more(next)}>
              Load more
            </Button>
          </td>
        </tr>
      )}
    </tbody>
  );
}

const appNames = (task: TaskSummary) =>
  task.apps.map((app) => app.appName ?? app.appId).join(", ") || "—";

function TaskView({
  range,
  taskKey,
  back,
}: {
  readonly range: UsageRange;
  readonly taskKey: string;
  readonly back: () => void;
}) {
  const { organization } = useOrganizationRoute();
  return (
    <div className="grid gap-4">
      <div>
        <Button variant="outline" size="sm" onClick={back}>
          All tasks
        </Button>
      </div>
      <QueryView query={taskAtom(organization, range, taskKey)} Failure={HostedFailure}>
        {(detail) => <Detail detail={detail} />}
      </QueryView>
    </div>
  );
}

function Detail({ detail }: { readonly detail: TaskDetail }) {
  const failures = detail.calls.filter((call) => call.outcome !== "success").length;
  const total = detail.calls.reduce((sum, call) => sum + call.durationMs, 0);
  const apps = new Set(detail.calls.map((call) => call.appId)).size;
  return (
    <div className="grid gap-6">
      <div>
        <p className="text-xs text-muted-foreground">{kindLabel[detail.kind]}</p>
        <h2 className="break-words font-mono text-lg font-semibold">{detail.label}</h2>
      </div>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3">
        <Tile label="Tool calls" value={count.format(detail.calls.length)} />
        <Tile label="Failures" value={count.format(failures)} />
        <Tile label="Apps" value={count.format(apps)} />
        <Tile label="Total duration" value={duration(total)} />
      </dl>
      <Section title="Calls in order">
        {detail.truncated && (
          <p className="mb-2 text-[13px] text-muted-foreground">
            This task has more calls than are shown. The first {count.format(detail.calls.length)}{" "}
            are listed.
          </p>
        )}
        <CallsTable calls={detail.calls} />
      </Section>
    </div>
  );
}

function CallsTable({ calls }: { readonly calls: ReadonlyArray<TaskCall> }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const toggle = (index: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  return (
    <Table caption="Calls in order">
      <thead className="border-b">
        <tr>
          <th scope="col" className={headCell}>
            Time
          </th>
          <th scope="col" className={headCell}>
            App
          </th>
          <th scope="col" className={headCell}>
            Tool
          </th>
          <th scope="col" className={headCell}>
            Outcome
          </th>
          <th scope="col" className={numberHead}>
            Duration
          </th>
          <th scope="col" className={headCell}>
            <span className="sr-only">Details</span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {calls.map((call, index) => {
          const expanded = open.has(index);
          const panel = `task-call-${index}`;
          return (
            <Fragment key={index}>
              <tr>
                <td className={`${cell} whitespace-nowrap text-muted-foreground`}>
                  <LocalTime value={new Date(call.at)} />
                </td>
                <td className={`${cell} break-words`}>{call.appName ?? call.appId}</td>
                <td className={`${cell} break-words font-mono text-[13px]`}>{call.toolName}</td>
                <td className={cell}>
                  <span className={call.outcome === "success" ? "" : "text-destructive"}>
                    {call.outcome === "success"
                      ? "ok"
                      : call.outcome === "cancelled"
                        ? "cancelled"
                        : "failed"}
                  </span>
                  {call.errorType !== null && (
                    <span className="ml-2 break-words font-mono text-xs text-muted-foreground">
                      {call.errorType}
                    </span>
                  )}
                </td>
                <td className={numberCell}>{duration(call.durationMs)}</td>
                <td className={cell}>
                  <button
                    type="button"
                    className="min-h-6 whitespace-nowrap text-xs text-muted-foreground underline-offset-2 hover:underline"
                    aria-expanded={expanded}
                    aria-controls={panel}
                    onClick={() => toggle(index)}
                  >
                    {expanded ? "Hide" : "Details"}
                  </button>
                </td>
              </tr>
              {expanded && (
                <tr id={panel}>
                  <td colSpan={6} className="bg-muted/30 px-4 py-3">
                    <dl className="grid gap-1.5 text-[13px]">
                      <CallField label="Session" value={call.sessionId} />
                      <CallField label="Run" value={call.runId} />
                    </dl>
                    <p className="mt-3 text-xs text-muted-foreground">Arguments (masked)</p>
                    {call.arguments === null ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Not recorded. Turn on argument recording in organization settings.
                      </p>
                    ) : (
                      <pre className="mt-1 max-h-72 overflow-auto rounded-md border bg-background p-3 font-mono text-xs whitespace-pre-wrap break-words">
                        {pretty(call.arguments)}
                      </pre>
                    )}
                    <p className="mt-3 text-xs text-muted-foreground">Response (masked)</p>
                    {call.response === null ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {call.outcome === "success"
                          ? "Not recorded. Turn on response recording in organization settings."
                          : "The call failed and has no response."}
                      </p>
                    ) : (
                      <pre className="mt-1 max-h-72 overflow-auto rounded-md border bg-background p-3 font-mono text-xs whitespace-pre-wrap break-words">
                        <LinkedFiles text={pretty(call.response)} files={call.files} />
                      </pre>
                    )}
                    {call.files.length > 0 && <CallFiles files={call.files} />}
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

function CallField({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div className="flex flex-wrap gap-x-3">
      <dt className="w-16 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-xs">{value ?? "none (stateless)"}</dd>
    </div>
  );
}

/** Stored arguments are JSON text, possibly cut at the size cap; show it indented when it parses. */
const pretty = (text: string) => {
  const parsed = Option.liftThrowable(() => JSON.parse(text) as unknown)();
  return Option.isSome(parsed) ? JSON.stringify(parsed.value, null, 2) : text;
};

const fileUri = /executor-file:\/\/[^\s"\\]+/g;
const filesPath = "/org/$organizationSlug/files" as const;

/** The file list link for one file: the Files page with its preview drawer open. */
function FileLink({
  file,
  children,
}: {
  readonly file: TaskCallFile;
  readonly children: ReactNode;
}) {
  const { slug: organizationSlug } = useOrganizationRoute();
  return (
    <Link
      to={filesPath}
      params={{ organizationSlug }}
      search={{ file: file.id }}
      className="underline underline-offset-2"
    >
      {children}
    </Link>
  );
}

/** The JSON text with each available file's address turned into a link to its preview. */
function LinkedFiles({
  text,
  files,
}: {
  readonly text: string;
  readonly files: readonly TaskCallFile[];
}) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(fileUri)) {
    const file = files.find((item) => item.uri === match[0]);
    if (file === undefined || !file.available) continue;
    parts.push(text.slice(last, match.index));
    parts.push(
      <FileLink key={match.index} file={file}>
        {match[0]}
      </FileLink>,
    );
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

/** The files a call's arguments or response name, with their type and size. */
function CallFiles({ files }: { readonly files: readonly TaskCallFile[] }) {
  return (
    <ul className="mt-2 grid gap-1 text-xs" aria-label="Files">
      {files.map((file) => {
        const detail = [file.contentType, file.size === null ? null : formatFileSize(file.size)]
          .filter((part) => part !== null)
          .join(", ");
        return (
          <li key={file.id} className="break-all">
            {file.available ? (
              <FileLink file={file}>{file.uri}</FileLink>
            ) : (
              <span className="text-muted-foreground">{file.uri}</span>
            )}{" "}
            <span className="text-muted-foreground">
              {file.available ? detail : "expired or deleted"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
