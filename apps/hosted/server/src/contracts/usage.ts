/**
 * Usage insights: one local record per finished tool call, and the aggregates the organization home
 * page reads. Recording is a product feature of the host's own storage, independent of product
 * analytics, so it ignores the analytics opt-out. Records hold identifiers and counts only, never
 * URLs, credentials, or messages. Tool-call arguments and responses are kept only for
 * organizations that turned each on, masked, and only in the host's own store: never in analytics
 * or feedback.
 */
import { AppId } from "@executor-js/sdk/core";
import { Context, Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  OrganizationForbidden,
  OrganizationReference,
  RequireOrganization,
} from "./organization.ts";

/** The API key a request authenticated with. Unset for sessions, OAuth bearers, and MCP requests. */
export const CurrentApiKey = Context.Reference<string | undefined>("hosted/CurrentApiKey", {
  defaultValue: () => undefined,
});

/**
 * The saved arguments of an approved call that is being resumed. The resume request does not
 * carry them, so the host names them here for the usage record. Never sent to analytics.
 */
export const CurrentToolArguments = Context.Reference<unknown>("hosted/CurrentToolArguments", {
  defaultValue: () => undefined,
});

export const UsageRange = Schema.Literals(["24h", "7d", "30d"]);
export type UsageRange = typeof UsageRange.Type;
/** Administrators see the whole organization; members see only their own calls. */
export const UsageScope = Schema.Literals(["organization", "self"]);
export type UsageScope = typeof UsageScope.Type;

/** What a call finished as. Approval pauses are not calls and are never recorded. */
export type UsageOutcome = "success" | "failure" | "cancelled";

/** One finished tool call. */
export interface UsageToolCall {
  readonly at: Date;
  readonly organizationId: string;
  readonly userId: string;
  /** `grant:<id>`, `apikey:<id>`, `user:<id>`, or `unknown`. */
  readonly agentKey: string;
  /** Best display name when written; later grant names are resolved when read. */
  readonly agentLabel: string;
  readonly source: string;
  readonly appId: string;
  readonly toolName: string;
  readonly outcome: UsageOutcome;
  readonly errorType?: string;
  readonly durationMs: number;
  /** Client-chosen, not unique: the calls an agent made for one task share it. */
  readonly taskId?: string;
  /** The MCP transport session; absent on a stateless connection. */
  readonly mcpSessionId?: string;
  /** One per top-level MCP call, or one per schedule or workflow run. */
  readonly runId?: string;
  /** Masked, size-capped JSON; present only when the organization records arguments. */
  readonly arguments?: string;
  /** Masked, size-capped JSON; present only when the organization records responses. */
  readonly response?: string;
}

export const UsageTotals = Schema.Struct({
  calls: Schema.Number,
  failures: Schema.Number,
  successRate: Schema.Number,
  activeAgents: Schema.Number,
  activeApps: Schema.Number,
  avgDurationMs: Schema.Number,
});
export const UsageDay = Schema.Struct({
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: Schema.String,
  calls: Schema.Number,
  failures: Schema.Number,
});
export const UsageApp = Schema.Struct({
  appId: AppId,
  appName: Schema.optional(Schema.String),
  calls: Schema.Number,
  failures: Schema.Number,
});
export const UsageAgentTool = Schema.Struct({
  appId: AppId,
  toolName: Schema.String,
  calls: Schema.Number,
});
export const UsageAgent = Schema.Struct({
  agentKey: Schema.String,
  label: Schema.String,
  calls: Schema.Number,
  failures: Schema.Number,
  /** ISO 8601 timestamp of the agent's latest call in the range. */
  lastUsedAt: Schema.String,
  topTools: Schema.Array(UsageAgentTool),
});
export const UsageFailureType = Schema.Struct({
  errorType: Schema.String,
  count: Schema.Number,
});

/** The stored aggregates, before the host adds the request's scope and app names. */
export const UsageAggregates = Schema.Struct({
  totals: UsageTotals,
  daily: Schema.Array(UsageDay),
  topApps: Schema.Array(UsageApp),
  agents: Schema.Array(UsageAgent),
  failureTypes: Schema.Array(UsageFailureType),
});
export type UsageAggregates = typeof UsageAggregates.Type;

export const UsageReport = Schema.Struct({
  /** False when this host keeps no usage records; the aggregates are then empty. */
  available: Schema.Boolean,
  scope: UsageScope,
  range: UsageRange,
  ...UsageAggregates.fields,
});
export type UsageReport = typeof UsageReport.Type;

/** Which stored text a scrub removes. */
export interface ScrubFields {
  readonly arguments?: boolean;
  readonly response?: boolean;
}

/** How long each organization keeps stored arguments and responses; organizations not listed use `defaultDays`. */
export interface ArgumentRetention {
  /** Applied to every organization not in `byOrganization`; absent leaves them alone. */
  readonly defaultDays?: number;
  readonly byOrganization: ReadonlyMap<string, number>;
}

/** A task as the list shows it: all of one task ID, or the untagged calls of one session or run. */
export interface TaskSummary {
  /** `task:<id>`, `session:<id>` or `run:<id>`. */
  readonly key: string;
  /** Epoch milliseconds. */
  readonly firstAt: number;
  readonly lastAt: number;
  readonly calls: number;
  readonly failures: number;
  readonly appIds: ReadonlyArray<string>;
  readonly totalDurationMs: number;
}

export interface TaskListQuery {
  readonly organization: string;
  readonly range: UsageRange;
  readonly limit: number;
  /** Continue after this task in newest-first order. */
  readonly after?: { readonly lastAt: number; readonly key: string };
}

export interface TaskCallRecord {
  readonly at: number;
  readonly appId: string;
  readonly toolName: string;
  readonly outcome: UsageOutcome;
  readonly errorType: string | null;
  readonly durationMs: number;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly arguments: string | null;
  readonly response: string | null;
}

export interface TaskCallsQuery {
  readonly organization: string;
  readonly range: UsageRange;
  readonly key: string;
  readonly limit: number;
}

export interface UsageQuery {
  readonly organization: string;
  /** Restrict to one user's calls. */
  readonly userId?: string;
  readonly range: UsageRange;
}

/**
 * The host's usage records. `record` never fails or waits: a record that cannot be kept is dropped,
 * never allowed to affect the tool call. `query` reads what was kept and returns empty aggregates
 * when it cannot. The default keeps nothing, as Cloud does.
 */
export const UsageStore = Context.Reference<{
  readonly available: boolean;
  readonly record: (call: UsageToolCall) => void;
  readonly query: (query: UsageQuery) => Effect.Effect<UsageAggregates>;
  /** Tasks newest first, one more than `limit` when more follow. Empty when it cannot read. */
  readonly tasks: (query: TaskListQuery) => Effect.Effect<ReadonlyArray<TaskSummary>>;
  /** The calls of one task in the order they were made, oldest first. */
  readonly taskCalls: (query: TaskCallsQuery) => Effect.Effect<ReadonlyArray<TaskCallRecord>>;
  /**
   * Remove stored arguments and responses older than each organization's retention, keeping the
   * rest of the records. `fields` limits it to one kind; both by default.
   */
  readonly scrubArguments: (
    retention: ArgumentRetention,
    fields?: ScrubFields,
  ) => Effect.Effect<void>;
}>("hosted/UsageStore", {
  defaultValue: () => ({
    available: false,
    record: () => {},
    query: () => Effect.succeed(emptyUsage),
    tasks: () => Effect.succeed([]),
    taskCalls: () => Effect.succeed([]),
    scrubArguments: () => Effect.void,
  }),
});

export const emptyUsage: UsageAggregates = {
  totals: {
    calls: 0,
    failures: 0,
    successRate: 0,
    activeAgents: 0,
    activeApps: 0,
    avgDurationMs: 0,
  },
  daily: [],
  topApps: [],
  agents: [],
  failureTypes: [],
};

/** Members of an organization read its tool-call usage; the response scope depends on their role. */
export const HostedUsage = HttpApiGroup.make("usage")
  .add(
    HttpApiEndpoint.get("get", "/api/organizations/:organization/usage", {
      params: { organization: OrganizationReference },
      query: { range: Schema.optional(UsageRange) },
      success: UsageReport,
      error: OrganizationForbidden,
    })
      .annotate(OpenApi.Summary, "Get tool usage")
      .annotate(
        OpenApi.Description,
        "Tool-call counts for the organization over the last 24 hours, 7 days (the default), or 30 days: totals, calls per day, the most used apps, and per-agent activity. Administrators see the whole organization; members see only their own calls. Returns available false when this instance keeps no usage records.",
      ),
  )
  .middleware(RequireOrganization);
