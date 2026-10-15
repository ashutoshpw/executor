/**
 * The task and run of each MCP `tools/call`. The decorator below reads the task ID from the
 * request `_meta` (or the tool's `taskId` argument), generates the run ID, provides both to the
 * handler so the programs it starts and the calls they make inherit them, and echoes the run ID
 * and task ID in the result's `_meta`.
 */
import { Effect, Layer } from "effect";
import { HttpServerRequest } from "effect/http";
import { McpSchema, McpServer } from "effect/ai";
import {
  CurrentResumedRun,
  CurrentTask,
  parseSessionId,
  resolveTaskId,
  runIdMetaKey,
  taskIdMetaKey,
  type ResumedRun,
  type TaskContext,
} from "../contracts/task.ts";

/** Add the run ID, and the task ID when there is one, to a result's `_meta`; nothing else changes. */
export const withRunMeta = (
  result: McpSchema.CallToolResult,
  task: TaskContext,
): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    ...result,
    _meta: {
      ...result._meta,
      [runIdMetaKey]: task.runId,
      ...(task.taskId === undefined ? {} : { [taskIdMetaKey]: task.taskId }),
    },
  });

/** The same `McpServer` with every registered tool run as one task and run. */
export const taskContextLayer: Layer.Layer<McpServer.McpServer, never, McpServer.McpServer> =
  Layer.effect(
    McpServer.McpServer,
    Effect.gen(function* () {
      const base = yield* McpServer.McpServer;
      const addTool: (typeof base)["addTool"] = (options) =>
        base.addTool({
          ...options,
          handle: (payload) =>
            Effect.gen(function* () {
              const context = yield* McpSchema.McpRequestContext;
              const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
              const header =
                request._tag === "Some" ? request.value.headers["mcp-session-id"] : undefined;
              const task: TaskContext = {
                taskId: resolveTaskId(context.requestMetadata, payload),
                sessionId: parseSessionId(header) ?? null,
                runId: crypto.randomUUID(),
              };
              const resumed: ResumedRun = { runId: undefined };
              const result = yield* options
                .handle(payload)
                .pipe(
                  Effect.provideService(CurrentTask, task),
                  Effect.provideService(CurrentResumedRun, resumed),
                );
              // A resume reports the run of the program it continues, which its records carry.
              return result instanceof McpSchema.CallToolResult
                ? withRunMeta(result, { ...task, runId: resumed.runId ?? task.runId })
                : result;
            }),
        });
      // The service holds its registries behind getters, so copy descriptors, not values.
      return Object.defineProperties(
        {},
        {
          ...Object.getOwnPropertyDescriptors(base),
          addTool: { value: addTool, enumerable: true },
        },
      ) as typeof base;
    }),
  );
