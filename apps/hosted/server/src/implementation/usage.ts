/** Attribution for the local usage records; analytics opt-outs do not apply to this product feature. */
import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect";
import { FileTransferHost } from "@executor-js/sdk/blobs";
import { CurrentTask } from "@executor-js/mcp";
import type { AutomationToolCall, AutomationToolObservation } from "@executor-js/sdk/scheduling";
import { toolCompletion } from "@executor-js/telemetry/product-analytics";
import { CurrentUserId, CurrentPrincipal } from "../contracts/auth.ts";
import { CurrentMcpGrant } from "../contracts/mcp.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { CurrentOrganization } from "../contracts/organization.ts";
import { patGrantOf } from "./mcp-oauth.ts";
import { CurrentUsage, usageFailure } from "../contracts/product-analytics.ts";
import { CurrentApiKey, UsageStore, type UsageOutcome } from "../contracts/usage.ts";
import { recordingSettings } from "./task-insights-settings.ts";
import { storedArguments } from "./task-arguments.ts";
import { prepareResponse, saveResponseMedia, unsavedMedia } from "./task-responses.ts";

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
  /** When the call started; the record is ordered by it. Defaults to now. */
  readonly startedAt?: number | undefined;
  /** The call's arguments. Kept, masked, only when the organization records them. */
  readonly arguments?: unknown;
  /**
   * The value of a completed call, wrapped so a null value is told from none. Kept, masked, only
   * when the organization records responses.
   */
  readonly response?: { readonly value: unknown } | undefined;
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
    const task = yield* CurrentTask;
    // Only MCP tool calls are recorded with arguments or responses. The setting is read only for
    // a call that has some, and a failed read means not recorded.
    const settings =
      (call.arguments === undefined && call.response === undefined) || task === undefined
        ? undefined
        : yield* recordingSettings(organization.value.organization);
    const kept =
      settings?.recordArguments === true
        ? storedArguments(call.arguments, settings.extraMaskedKeys)
        : undefined;
    const organizationId = organization.value.organization;
    const record = (response: string | undefined) =>
      // A record that cannot be kept never reaches the tool call.
      Effect.try(() =>
        store.record({
          at: new Date(call.startedAt ?? Date.now()),
          organizationId,
          userId,
          agentKey,
          agentLabel: agentLabel.slice(0, 200),
          source: usage.source,
          appId,
          toolName,
          outcome: call.outcome,
          ...(call.errorType === undefined ? {} : { errorType: call.errorType }),
          durationMs: call.durationMs,
          ...(task?.taskId === undefined ? {} : { taskId: task.taskId }),
          ...(task?.sessionId == null ? {} : { mcpSessionId: task.sessionId }),
          ...(task === undefined ? {} : { runId: task.runId }),
          ...(kept === undefined ? {} : { arguments: kept }),
          ...(response === undefined ? {} : { response }),
        }),
      ).pipe(Effect.ignore);
    if (settings?.recordResponses !== true || call.response === undefined)
      return yield* record(undefined);
    // Saving media needs the request's file storage, so it is looked up before anything is
    // detached from the request.
    const executor = yield* Effect.serviceOption(HostedExecutor);
    const transfer = Option.isNone(executor)
      ? undefined
      : yield* executor.value.pipe(
          Effect.map((found) => found[FileTransferHost]),
          Effect.orElseSucceed(() => undefined),
        );
    const prepared = yield* Effect.try(() =>
      prepareResponse(call.response?.value, {
        organization: organizationId,
        extraKeys: settings.extraMaskedKeys,
        limit: transfer === undefined ? 0 : transfer.userContent.policy.maxFileBytes,
      }),
    ).pipe(Effect.option);
    // A response that cannot be prepared is not recorded.
    if (Option.isNone(prepared)) return yield* record(undefined);
    const { media, finish } = prepared.value;
    // Without media the record is made now, as arguments are.
    if (media.length === 0 || transfer === undefined)
      return yield* record(finish(media.map((item) => unsavedMedia(item.contentType, item.size))));
    const owner = organization.value.owner;
    // The tool call must not wait for files to be stored, so the save and the record run on their own.
    yield* saveResponseMedia({
      transfer,
      organization: organizationId,
      owner,
      appId,
      media,
    }).pipe(
      Effect.flatMap((replacements) => record(finish(replacements))),
      Effect.catchCause(() => Effect.logWarning("A tool response could not be recorded")),
      Effect.forkDetach,
    );
  });

/** Failures that end a call before the tool runs. */
const notRun = new Set([
  "HostToolApprovalRequired",
  "HostToolBlocked",
  "HostToolNotFound",
  "HostKindMismatch",
  "HostInputInvalid",
]);

/** How an automation's tool call finished, or nothing when it did not run the tool. */
const automationResult = (
  call: AutomationToolCall,
): { readonly outcome?: UsageOutcome; readonly error_type?: string } | undefined => {
  if (Exit.isFailure(call.exit)) {
    // A workflow step that paused for approval, was blocked or was rejected before dispatch
    // did not run the tool, the same as an approval pause or a lookup miss for a schedule.
    const error = Cause.findErrorOption(call.exit.cause);
    if (
      Option.isSome(error) &&
      notRun.has(Predicate.hasProperty(error.value, "_tag") ? String(error.value._tag) : "")
    )
      return undefined;
    return usageFailure(call.exit.cause);
  }
  if (call.source === "workflow") return { outcome: "success" };
  // A schedule reports the tool result. An approval pause is not a call, and a repeated or late
  // answer did not run the tool.
  const result = Schema.decodeUnknownOption(
    Schema.Struct({
      status: Schema.String,
      toolError: Schema.optional(Schema.Boolean),
      reason: Schema.optional(Schema.String),
    }),
  )(call.exit.value);
  if (Option.isNone(result)) return undefined;
  const { status, reason } = result.value;
  if (status === "approval-required" || status === "already-consumed") return undefined;
  if (status === "failed" && reason === "expired") return undefined;
  return toolCompletion(result.value);
};

/**
 * Keep one record of each tool call a schedule or workflow makes, attributed to that automation
 * the way a request is to its agent. The record belongs to the user the work runs for, so members
 * see their own schedules and workflows, and administrators also see app schedules and workflows
 * started without a caller, which carry no user. Runs have no request to read an organization
 * from, so it comes from the app's owner.
 */
export const automationUsage = (
  store: typeof UsageStore.Service,
): typeof AutomationToolObservation.Service => ({
  completed: (call) =>
    Effect.sync(() => {
      if (!store.available || !call.owner.startsWith("organization:")) return;
      const result = automationResult(call);
      if (result?.outcome === undefined) return;
      store.record({
        at: new Date(Date.now() - call.durationMs),
        organizationId: call.owner.slice("organization:".length),
        userId: call.actor ?? "",
        agentKey: `${call.source}:${call.automation.id}`,
        agentLabel: call.automation.name.slice(0, 200),
        source: call.source,
        appId: call.app,
        toolName: call.tool,
        outcome: result.outcome,
        ...(result.error_type === undefined ? {} : { errorType: result.error_type }),
        durationMs: call.durationMs,
        ...(call.runId === undefined ? {} : { runId: call.runId }),
      });
    }).pipe(Effect.catchCause(() => Effect.void)),
});
