/** Read the usage records for the organization home page. */
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { McpAuthentication } from "../contracts/mcp.ts";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";
import {
  UsageStore,
  type UsageAggregates,
  type UsageRange,
  type UsageReport,
} from "../contracts/usage.ts";
import { visibleApps } from "./resource-policy.ts";

const days = { "24h": 2, "7d": 8, "30d": 31 } as const satisfies Record<UsageRange, number>;
const dayMillis = 24 * 60 * 60 * 1000;

/** One entry per UTC day the range touches, ending today, so quiet days show as zero rather than disappearing. */
const withEmptyDays = (
  range: UsageRange,
  daily: UsageAggregates["daily"],
  now: number,
): UsageAggregates["daily"] => {
  const counted = new Map(daily.map((day) => [day.date, day]));
  return Array.from({ length: days[range] }, (_, index) => {
    const date = new Date(now - (days[range] - 1 - index) * dayMillis).toISOString().slice(0, 10);
    return counted.get(date) ?? { date, calls: 0, failures: 0 };
  });
};

/** Administrators read the organization; members read only their own calls. */
export const hostedUsageHandlers = HttpApiBuilder.group(HostedApi, "usage", (handlers) =>
  Effect.gen(function* () {
    const mcp = yield* Effect.serviceOption(McpAuthentication);
    return handlers.handle("get", ({ query }) =>
      Effect.gen(function* () {
        const range = query.range ?? "7d";
        const organization = yield* CurrentOrganization;
        const userId = yield* CurrentUserId;
        const scope = organization.role === "member" ? "self" : "organization";
        if (scope === "self" && userId === undefined) return yield* new OrganizationForbidden();
        const store = yield* UsageStore;
        const base = { scope, range } as const;
        if (!store.available)
          return {
            available: false,
            ...base,
            ...(yield* store.query({ organization: organization.organization, range })),
          } satisfies UsageReport;
        const usage = yield* store.query({
          organization: organization.organization,
          ...(scope === "self" && userId !== undefined ? { userId } : {}),
          range,
        });
        // Names are a convenience; a failed lookup leaves the stored labels and app IDs.
        const names = yield* Effect.flatten(HostedExecutor).pipe(
          Effect.flatMap((executor) => executor.apps.list({ owner: organization.owner })),
          Effect.flatMap(scope === "self" ? visibleApps : Effect.succeed),
          Effect.map((apps) => new Map(apps.map((app) => [app.id, app.name]))),
          Effect.catch(() => Effect.succeed(new Map<string, string>())),
        );
        // The caller's own grants are named by the client they authorized, not what it announced.
        const grants = new Map<string, string>();
        if (Option.isSome(mcp) && userId !== undefined)
          for (const agent of yield* mcp.value.connections
            .agents({ userId, resource: organization.organization })
            .pipe(Effect.catch(() => Effect.succeed([]))))
            if (agent.name !== null && agent.name !== "")
              grants.set(`grant:${agent.id}`, agent.name);
        return {
          available: true,
          ...base,
          ...usage,
          daily: withEmptyDays(range, usage.daily, Date.now()),
          topApps: usage.topApps.map((app) => {
            const name = names.get(app.appId);
            return name === undefined ? app : { ...app, appName: name };
          }),
          agents: usage.agents.map((agent) => ({
            ...agent,
            label: grants.get(agent.agentKey) ?? agent.label,
          })),
        } satisfies UsageReport;
      }),
    );
  }),
);
