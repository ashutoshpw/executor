/** Read task insights for owners and admins: tasks grouped from the usage records. */
import { Effect, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { FileTransferHost } from "@executor-js/sdk/blobs";
import { AppId, type OwnerId } from "@executor-js/sdk/core";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";
import {
  defaultTasksPageSize,
  maxTaskCallFiles,
  maxTaskCalls,
  type TaskCallFile,
  TaskNotFound,
  TasksCursorInvalid,
  type TaskKind,
} from "../contracts/tasks.ts";
import { UsageStore, type TaskSummary } from "../contracts/usage.ts";
import { readableRecordingSettings } from "./task-insights-settings.ts";

const dayMillis = 24 * 60 * 60 * 1000;

const kinds = ["task", "session", "run"] as const satisfies ReadonlyArray<TaskKind>;
/** Split `task:<id>`, `session:<id>` or `run:<id>`; anything else is not a key this host issued. */
const parseKey = (key: string) => {
  const kind = kinds.find((candidate) => key.startsWith(`${candidate}:`));
  return kind === undefined ? undefined : { kind, label: key.slice(kind.length + 1) };
};

const Cursor = Schema.Struct({ t: Schema.Int, k: Schema.String });
const encodeCursor = (task: TaskSummary) =>
  Base64Url.encode(JSON.stringify({ t: task.lastAt, k: task.key }));
const decodeCursor = (value: string) =>
  Effect.fromResult(Base64Url.decodeString(value)).pipe(
    Effect.flatMap((text) => Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor))(text)),
    Effect.filterOrFail(
      (cursor) => cursor.t >= 0 && cursor.t < 8.64e15 && parseKey(cursor.k) !== undefined,
      () => new TasksCursorInvalid(),
    ),
    Effect.mapError(() => new TasksCursorInvalid()),
    Effect.map((cursor) => ({ lastAt: cursor.t, key: cursor.k })),
  );

/** Names are a convenience; a failed lookup leaves the app IDs. */
const appNames = (owner: OwnerId) =>
  Effect.flatten(HostedExecutor).pipe(
    Effect.flatMap((executor) => executor.apps.list({ owner })),
    Effect.map((apps) => new Map(apps.map((app) => [app.id as string, app.name]))),
    Effect.catch(() => Effect.succeed(new Map<string, string>())),
  );

const named = (
  names: ReadonlyMap<string, string>,
  appId: string,
): { readonly appName?: string } => {
  const name = names.get(appId);
  return name === undefined ? {} : { appName: name };
};

const fileUri = /executor-file:\/\/([^/\s"\\]+)\/([^\s"\\]+)/gu;

/** The file IDs of this organization that some text names by address, in order, without repeats. */
const namedFiles = (organization: string, texts: ReadonlyArray<string | null>) => {
  const found = new Map<string, string>();
  for (const text of texts) {
    if (text === null) continue;
    for (const match of text.matchAll(fileUri)) {
      if (found.size >= maxTaskCallFiles) return found;
      try {
        // Another organization's address names nothing here.
        if (decodeURIComponent(match[1] ?? "") !== organization) continue;
        const id = decodeURIComponent(match[2] ?? "");
        if (id !== "" && !found.has(id)) found.set(id, match[0]);
      } catch {
        // Not a valid address; skip it.
      }
    }
  }
  return found;
};

/** The most distinct files looked up for one request; files beyond it are shown as unavailable. */
const maxStatsPerRequest = 200;

type FileState = Pick<TaskCallFile, "contentType" | "size" | "available">;
const unavailable: FileState = { contentType: null, size: null, available: false };

/**
 * The state of each distinct file the calls name, looked up once in the organization's file store.
 * Beyond `maxStatsPerRequest` distinct files the rest are not looked up and count as unavailable.
 */
const resolveFiles = (organization: string, owner: OwnerId, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const states = new Map<string, FileState>();
    const wanted = ids.slice(0, maxStatsPerRequest);
    if (wanted.length === 0) return states;
    const executor = yield* Effect.flatten(HostedExecutor);
    const transfer = executor[FileTransferHost];
    if (transfer === undefined) return states;
    yield* Effect.forEach(
      wanted,
      (id) =>
        transfer.userContent.handles.stat({ owner, id }).pipe(
          Effect.map((found): FileState => ({
            contentType: found.handle.contentType,
            size: found.handle.size,
            available: true,
          })),
          Effect.orElseSucceed(() => unavailable),
          Effect.tap((state) => Effect.sync(() => states.set(id, state))),
        ),
      { concurrency: 8, discard: true },
    );
    return states;
  }).pipe(Effect.orElseSucceed(() => new Map<string, FileState>()));

/** Only owners and admins read tasks; every query is scoped to the caller's organization. */
export const hostedTasksHandlers = HttpApiBuilder.group(HostedApi, "tasks", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      Effect.gen(function* () {
        const access = yield* CurrentOrganization;
        if (access.role === "member") return yield* new OrganizationForbidden();
        const range = query.range ?? "7d";
        const store = yield* UsageStore;
        if (!store.available) return { available: false, range, tasks: [], next: null };
        const limit = query.limit ?? defaultTasksPageSize;
        const after = query.after === undefined ? undefined : yield* decodeCursor(query.after);
        // One extra row says whether another page follows.
        const found = yield* store.tasks({
          organization: access.organization,
          range,
          limit: limit + 1,
          ...(after === undefined ? {} : { after }),
        });
        const page = found.slice(0, limit);
        const last = page[page.length - 1];
        const names = yield* appNames(access.owner);
        return {
          available: true,
          range,
          tasks: page.map((task) => {
            const parsed = parseKey(task.key);
            return {
              key: task.key,
              kind: parsed?.kind ?? "run",
              label: parsed?.label ?? task.key,
              firstAt: new Date(task.firstAt).toISOString(),
              lastAt: new Date(task.lastAt).toISOString(),
              calls: task.calls,
              failures: task.failures,
              apps: task.appIds.map((appId) => ({
                appId: AppId.make(appId),
                ...named(names, appId),
              })),
              totalDurationMs: task.totalDurationMs,
            };
          }),
          next: found.length > limit && last !== undefined ? encodeCursor(last) : null,
        } as const;
      }),
    )
    .handle("get", ({ query }) =>
      Effect.gen(function* () {
        const access = yield* CurrentOrganization;
        if (access.role === "member") return yield* new OrganizationForbidden();
        const range = query.range ?? "7d";
        const parsed = parseKey(query.key);
        if (parsed === undefined) return yield* new TaskNotFound();
        const store = yield* UsageStore;
        if (!store.available)
          return {
            available: false,
            range,
            key: query.key,
            kind: parsed.kind,
            label: parsed.label,
            calls: [],
            truncated: false,
          };
        const found = yield* store.taskCalls({
          organization: access.organization,
          range,
          key: query.key,
          limit: maxTaskCalls + 1,
        });
        if (found.length === 0) return yield* new TaskNotFound();
        const names = yield* appNames(access.owner);
        // The sweep removes old arguments and responses on a schedule; none is shown past retention
        // before it runs.
        // When the setting cannot be read, nothing is shown: the retention is unknown.
        const settings = yield* readableRecordingSettings(access.organization);
        const cutoff =
          settings === undefined
            ? Number.POSITIVE_INFINITY
            : Date.now() - settings.retentionDays * dayMillis;
        const shown = found.slice(0, maxTaskCalls).map((call) => {
          const kept = call.at >= cutoff;
          const args = kept ? call.arguments : null;
          const response = kept ? call.response : null;
          return {
            call,
            args,
            response,
            named: namedFiles(access.organization, [args, response]),
          };
        });
        // Calls often name the same file, so each distinct file is looked up once per request.
        const distinct = new Set(shown.flatMap((item) => [...item.named.keys()]));
        const states = yield* resolveFiles(access.organization, access.owner, [...distinct]);
        const calls = shown.map(({ call, args, response, named: files }) => ({
          at: new Date(call.at).toISOString(),
          appId: AppId.make(call.appId),
          ...named(names, call.appId),
          toolName: call.toolName,
          outcome: call.outcome,
          errorType: call.errorType,
          durationMs: call.durationMs,
          sessionId: call.sessionId,
          runId: call.runId,
          arguments: args,
          response,
          files: [...files].map(([id, uri]): TaskCallFile => ({
            id,
            uri,
            ...(states.get(id) ?? unavailable),
          })),
        }));
        return {
          available: true,
          range,
          key: query.key,
          kind: parsed.kind,
          label: parsed.label,
          calls,
          truncated: found.length > maxTaskCalls,
        };
      }),
    ),
);
