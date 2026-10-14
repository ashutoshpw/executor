/** Effect-only host lifecycle. These privileged operations are not mounted on the SDK HTTP API. */
import { Clock, Context, Effect, type Exit } from "effect";
import type { ScheduledRun } from "./schedules.ts";
import type { AppId, OwnerId, StorageError } from "./shared.ts";

/** Authorize the saved actor against current product membership and app/account access before every dispatch. */
export interface ScheduleAuthority {
  readonly app: AppId;
  readonly owner: OwnerId;
  /** The schedule's actor; null for an app schedule, which an app manager enabled for the app. */
  readonly actor: string | null;
  readonly phase: "start" | "resume";
}
/** A host owns the named runner for its whole lifetime. Recovery requires the old runner to have stopped. */
export interface ScheduleDispatcher {
  readonly tick: (options: {
    readonly runner: string;
    readonly maxCandidates: number;
    readonly authorize: (target: ScheduleAuthority) => Effect.Effect<void, Error>;
    /** Host-owned admission gate. Skip the effect when full, leaving the occurrence unclaimed for the next wake. */
    readonly execute: (
      operation: Effect.Effect<void, StorageError>,
    ) => Effect.Effect<void, StorageError>;
  }) => Effect.Effect<void, StorageError>;
  readonly recover: (runner: string) => Effect.Effect<void, StorageError>;
  readonly nextWake: Effect.Effect<Date | null, StorageError>;
}

/** Optional host observer runs after a terminal transition commits, without payloads or credentials. */
export const ScheduleObservation = Context.Reference<{
  readonly completed: (
    run: Pick<
      ScheduledRun,
      "id" | "scheduleId" | "app" | "owner" | "status" | "startedAt" | "finishedAt"
    >,
  ) => Effect.Effect<void>;
}>("executor/ScheduleObservation", { defaultValue: () => ({ completed: () => Effect.void }) });

/** One tool call a schedule or a workflow step made on its own, without a caller waiting on it. */
export interface AutomationToolCall {
  readonly source: "schedule" | "workflow";
  readonly app: AppId;
  readonly owner: OwnerId;
  /** Whom the work runs for; null for an app schedule or a workflow started without a caller. */
  readonly actor: string | null;
  /** The schedule copy's ID, or the workflow's name within its app. */
  readonly automation: { readonly id: string; readonly name: string };
  readonly tool: string;
  readonly durationMs: number;
  /** A schedule's tool result, a workflow step's output, or the failure that ended the call. */
  readonly exit: Exit.Exit<unknown, unknown>;
}

/**
 * Optional host observer for tool calls that schedules and workflows make, reported when each call
 * finishes. It is advisory: a failing observer never reaches the run, and the call never waits on
 * more than the effect it returns.
 */
export const AutomationToolObservation = Context.Reference<{
  readonly completed: (call: AutomationToolCall) => Effect.Effect<void>;
}>("executor/AutomationToolObservation", {
  defaultValue: () => ({ completed: () => Effect.void }),
});

/** Report a finished automation call without letting the observer disturb the run. */
export const observeAutomationTool = <A, E, R>(
  call: Omit<AutomationToolCall, "durationMs" | "exit">,
  work: Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(Clock.currentTimeMillis, (started) =>
    work.pipe(
      Effect.onExit((exit) =>
        Effect.flatMap(Clock.currentTimeMillis, (finished) =>
          Effect.flatMap(AutomationToolObservation, (observer) =>
            observer.completed({ ...call, durationMs: Math.max(0, finished - started), exit }),
          ),
        ).pipe(Effect.catchCause(() => Effect.void)),
      ),
    ),
  );
