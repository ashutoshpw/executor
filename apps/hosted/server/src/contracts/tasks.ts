/**
 * Task insights: the tool calls an agent made for one task, in order. A task is every call that
 * shares a client-chosen task ID; calls without one are grouped by their MCP session, else by run.
 * Owners and admins read the whole organization's tasks; members read none, because arguments and
 * task names can hold other people's work.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { ApiError } from "@executor-js/utils/api-error";
import { AppId } from "@executor-js/sdk/core";
import {
  OrganizationForbidden,
  OrganizationReference,
  RequireOrganization,
} from "./organization.ts";
import { UsageRange } from "./usage.ts";

/** The most tasks one page lists, and how many it lists when the caller names no limit. */
export const maxTasksPageSize = 100;
export const defaultTasksPageSize = 25;
/** The most files listed for one call. */
export const maxTaskCallFiles = 20;
/** The most calls the detail view returns for one task. */
export const maxTaskCalls = 1000;

/** The page cursor is not one this host issued. */
export const TasksCursorInvalid = ApiError.define({
  tag: "TasksCursorInvalid",
  status: 400,
  message: "This page cursor is not valid. Start again from the first page.",
});
export type TasksCursorInvalid = typeof TasksCursorInvalid.Type;

/** The task key names no calls in the range. */
export const TaskNotFound = ApiError.define({
  tag: "TaskNotFound",
  status: 404,
  message: "No calls were recorded for this task in the selected range.",
});
export type TaskNotFound = typeof TaskNotFound.Type;

/** `task` groups by task ID; `session` and `run` group calls that carry none. */
export const TaskKind = Schema.Literals(["task", "session", "run"]);
export type TaskKind = typeof TaskKind.Type;

export const TaskApp = Schema.Struct({
  appId: AppId,
  appName: Schema.optional(Schema.String),
});

export const TaskSummary = Schema.Struct({
  /** Pass to the detail endpoint. Opaque to clients. */
  key: Schema.String,
  kind: TaskKind,
  /** The task ID for `task`; the session or run ID for the others. */
  label: Schema.String,
  /** ISO 8601 timestamps of the first and last call in the range. */
  firstAt: Schema.String,
  lastAt: Schema.String,
  calls: Schema.Number,
  failures: Schema.Number,
  apps: Schema.Array(TaskApp),
  totalDurationMs: Schema.Number,
});
export type TaskSummary = typeof TaskSummary.Type;

export const TaskList = Schema.Struct({
  /** False when this host keeps no usage records; the list is then empty. */
  available: Schema.Boolean,
  range: UsageRange,
  tasks: Schema.Array(TaskSummary),
  /** Pass as `after` for the following page; null on the last page. */
  next: Schema.NullOr(Schema.String),
});
export type TaskList = typeof TaskList.Type;

/** A file a call's arguments or response name by its `executor-file://` address. */
export const TaskCallFile = Schema.Struct({
  id: Schema.String,
  /** The address, `executor-file://<organization id>/<file id>`. */
  uri: Schema.String,
  contentType: Schema.NullOr(Schema.String),
  size: Schema.NullOr(Schema.Number),
  /** False when the file expired or was removed; the address then opens nothing. */
  available: Schema.Boolean,
});
export type TaskCallFile = typeof TaskCallFile.Type;

export const TaskCall = Schema.Struct({
  /** ISO 8601 time the call started. */
  at: Schema.String,
  appId: AppId,
  appName: Schema.optional(Schema.String),
  toolName: Schema.String,
  outcome: Schema.Literals(["success", "failure", "cancelled"]),
  errorType: Schema.NullOr(Schema.String),
  durationMs: Schema.Number,
  sessionId: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.String),
  /** The masked arguments, as JSON text. Null unless the organization recorded them. */
  arguments: Schema.NullOr(Schema.String),
  /** The masked response, as JSON text. Null unless the organization recorded it. */
  response: Schema.NullOr(Schema.String),
  /** Files the arguments or response point at, at most 20 per call. */
  files: Schema.Array(TaskCallFile),
});
export type TaskCall = typeof TaskCall.Type;

export const TaskDetail = Schema.Struct({
  available: Schema.Boolean,
  range: UsageRange,
  key: Schema.String,
  kind: TaskKind,
  label: Schema.String,
  /** Oldest first. */
  calls: Schema.Array(TaskCall),
  /** True when the task has more calls than `calls` holds. */
  truncated: Schema.Boolean,
});
export type TaskDetail = typeof TaskDetail.Type;

const organization = { organization: OrganizationReference };
const errors = [OrganizationForbidden];

export const HostedTasks = HttpApiGroup.make("tasks")
  .add(
    HttpApiEndpoint.get("list", "/api/organizations/:organization/tasks", {
      params: organization,
      query: {
        range: Schema.optional(UsageRange),
        limit: Schema.optional(
          Schema.FiniteFromString.check(
            Schema.isInt(),
            Schema.isBetween({ minimum: 1, maximum: maxTasksPageSize }),
          ),
        ),
        after: Schema.optional(Schema.NonEmptyString),
      },
      success: TaskList,
      error: [...errors, TasksCursorInvalid],
    })
      .annotate(OpenApi.Summary, "List tasks")
      .annotate(
        OpenApi.Description,
        "Tool calls grouped by task, newest first, over the last 24 hours, 7 days (the default), or 30 days. Owners and admins only. Returns available false when this instance keeps no usage records.",
      ),
  )
  .add(
    HttpApiEndpoint.get("get", "/api/organizations/:organization/tasks/detail", {
      params: organization,
      query: { key: Schema.NonEmptyString, range: Schema.optional(UsageRange) },
      success: TaskDetail,
      error: [...errors, TaskNotFound],
    })
      .annotate(OpenApi.Summary, "Get a task")
      .annotate(
        OpenApi.Description,
        "The calls of one task in the order they were made, with masked arguments and responses when the organization records them, and the files they name. Owners and admins only.",
      ),
  )
  .middleware(RequireOrganization);
