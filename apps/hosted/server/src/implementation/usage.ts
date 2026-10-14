/** Attribution for the local usage records; analytics opt-outs do not apply to this product feature. */
import { Effect, Option } from "effect";
import { CurrentUserId, CurrentPrincipal } from "../contracts/auth.ts";
import { CurrentMcpGrant } from "../contracts/mcp.ts";
import { CurrentOrganization } from "../contracts/organization.ts";
import { patGrantOf } from "./mcp-oauth.ts";
import { CurrentUsage } from "../contracts/product-analytics.ts";
import { CurrentApiKey, UsageStore, type UsageOutcome } from "../contracts/usage.ts";

const sourceLabels: Record<string, string> = {
  dashboard: "Dashboard",
  api: "API",
  mcp: "MCP client",
  app_ui: "App",
  schedule: "Schedule",
  workflow: "Workflow",
};

/**
 * Keep one record of a finished tool call. The agent is the MCP grant, else the API key, else the
 * signed-in user. Without an organization or user there is nothing to attribute, so nothing is kept.
 */
export const recordToolCall = (call: {
  readonly appId: string | undefined;
  readonly toolName: string | undefined;
  readonly outcome: UsageOutcome;
  readonly errorType?: string | undefined;
  readonly durationMs: number;
}) =>
  Effect.gen(function* () {
    const store = yield* UsageStore;
    if (!store.available) return;
    const usage = yield* CurrentUsage;
    const appId = call.appId ?? usage.app_id;
    const toolName = call.toolName ?? usage.tool_name;
    const userId = yield* CurrentUserId;
    const organization = yield* Effect.serviceOption(CurrentOrganization);
    if (appId === undefined || toolName === undefined || userId === undefined) return;
    if (Option.isNone(organization)) return;
    const grant = yield* CurrentMcpGrant;
    // A personal access token's synthetic grant names its API key, so it counts as that key.
    const patKey = grant === undefined ? Option.none() : patGrantOf(grant);
    const key = Option.isSome(patKey) ? patKey.value.token : yield* CurrentApiKey;
    const oauthGrant = Option.isSome(patKey) ? undefined : grant;
    const principal = yield* Effect.serviceOption(CurrentPrincipal);
    const fallback = usage.client_name ?? sourceLabels[usage.source] ?? "Unknown";
    const [agentKey, agentLabel] =
      oauthGrant !== undefined
        ? [`grant:${oauthGrant}`, fallback]
        : key !== undefined
          ? [`apikey:${key}`, usage.client_name ?? "API key"]
          : [
              `user:${userId}`,
              Option.isSome(principal) && principal.value.name !== ""
                ? principal.value.name
                : fallback,
            ];
    // A record that cannot be kept never reaches the tool call.
    yield* Effect.try(() =>
      store.record({
        at: new Date(),
        organizationId: organization.value.organization,
        userId,
        agentKey,
        agentLabel: agentLabel.slice(0, 200),
        source: usage.source,
        appId,
        toolName,
        outcome: call.outcome,
        ...(call.errorType === undefined ? {} : { errorType: call.errorType }),
        durationMs: call.durationMs,
      }),
    ).pipe(Effect.ignore);
  });
