/**
 * Usage insights: one local record per finished tool call, and the aggregates the organization home
 * page reads. Recording is a product feature of the host's own storage, independent of product
 * analytics, so it ignores the analytics opt-out. Records hold identifiers and counts only, never
 * arguments, results, URLs, credentials, or messages.
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
}>("hosted/UsageStore", {
  defaultValue: () => ({
    available: false,
    record: () => {},
    query: () => Effect.succeed(emptyUsage),
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
