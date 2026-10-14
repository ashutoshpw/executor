/** Product analytics at the shared hosted Executor boundary, used by Cloud and self-host. */
import type { Executor, ToolCallResult, ToolResumeResult } from "@executor-js/sdk/core";
import { toolCompletion } from "@executor-js/telemetry/product-analytics";
import { Clock, Effect, Exit } from "effect";
import { recordToolCall } from "./usage.ts";
import {
  observeUsage,
  recordUsage,
  usageFailure,
  type UsageProperties,
} from "../contracts/product-analytics.ts";

/** Instrument completed tool work while keeping approval pauses out of completion counts. */
const observeTool = <A extends ToolCallResult | ToolResumeResult, E, R>(
  properties: UsageProperties,
  work: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    yield* recordUsage("tool_execution_started", properties);
    return yield* work.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const duration = Math.max(0, (yield* Clock.currentTimeMillis) - started);
          const timed = { ...properties, duration_ms: duration };
          const record = (finished: {
            readonly outcome?: "success" | "failure" | "cancelled" | undefined;
            readonly error_type?: string | undefined;
          }) =>
            finished.outcome === undefined
              ? Effect.void
              : recordToolCall({
                  appId: properties.app_id,
                  toolName: properties.tool_name,
                  outcome: finished.outcome,
                  errorType: finished.error_type,
                  durationMs: duration,
                });
          if (Exit.isFailure(exit)) {
            const failure = usageFailure(exit.cause);
            yield* recordUsage("tool_execution_completed", { ...timed, ...failure });
            yield* record(failure);
            return;
          }
          const status = exit.value.status;
          if (status !== "approval-required") {
            const completion = toolCompletion(exit.value);
            yield* recordUsage("tool_execution_completed", { ...timed, status, ...completion });
            // A repeated or late answer did not run the tool, so it is not another call.
            const replayed =
              status === "already-consumed" ||
              (status === "failed" && "reason" in exit.value && exit.value.reason === "expired");
            if (!replayed) yield* record(completion);
          } else {
            yield* recordUsage("tool_approval_requested", { ...timed, status });
          }
        }),
      ),
    );
  }).pipe(Effect.withSpan("product.tool.execution"));

/** Product host boundaries cover API/MCP work and private app queries without inspecting payloads. */
export const withExecutorAnalytics = (executor: Executor): Executor => ({
  ...executor,
  tools: {
    ...executor.tools,
    call: (input, options) =>
      observeTool(
        { app_id: input.app, tool_name: input.tool },
        executor.tools.call(input, options),
      ),
    resume: (input, options) =>
      observeTool({ resumed: true }, executor.tools.resume(input, options)),
  },
  appData: {
    ...executor.appData,
    query: (input) =>
      observeUsage(
        "app_query_completed",
        { app_id: input.app, operation: input.name },
        executor.appData.query(input),
      ),
    mutate: (input) =>
      observeUsage(
        "app_mutation_completed",
        { app_id: input.app, operation: input.name },
        executor.appData.mutate(input),
      ),
    subscribe: (input) =>
      observeUsage(
        "app_subscription_started",
        { app_id: input.app, operation: input.name },
        executor.appData.subscribe(input),
      ),
  },
  accountConnections: {
    ...executor.accountConnections,
    submit: (input) =>
      executor.accountConnections.submit(input).pipe(
        Effect.tap((account) =>
          recordUsage("account_connected", {
            method: "credentials",
            account_id: account.id,
            provider_id: account.provider,
          }),
        ),
      ),
    completeOAuth: (input) =>
      executor.accountConnections.completeOAuth(input).pipe(
        Effect.tap((account) =>
          recordUsage("account_connected", {
            method: "oauth",
            account_id: account.id,
            provider_id: account.provider,
          }),
        ),
      ),
  },
  apps: {
    ...executor.apps,
    deploy: (input) =>
      executor.apps.deploy(input).pipe(
        Effect.tap((result) =>
          recordUsage("app_deployed", {
            app_id: result.app.id,
            deployment_id: result.deployment.id,
          }),
        ),
      ),
  },
});
