/**
 * End of life for user-content files. A handle's row says when its file expires; the sweep removes
 * the object first and the row last, so a reader never finds a row without bytes, and a removal that
 * fails is retried by the next sweep instead of being lost.
 */
import { Effect, Schedule } from "effect";
import type { BlobStorage } from "../contracts/blobs.ts";
import type { FileHandleStore } from "../contracts/file-handles.ts";

const batch = 100;
/** The most one sweep keeps working, so a backlog never starves the loop that runs it. */
const sweepBudgetMs = 20_000;

/** Remove every file whose time has come, within the budget. Returns how many it removed. */
export const sweepFileHandles = (options: {
  readonly handles: FileHandleStore;
  readonly store: BlobStorage;
  readonly budgetMs?: number;
}) =>
  Effect.gen(function* () {
    const started = Date.now();
    let removed = 0;
    while (Date.now() - started < (options.budgetMs ?? sweepBudgetMs)) {
      const claimed = yield* options.handles.claimExpired({ limit: batch });
      for (const row of claimed) {
        const done = yield* options.store.remove(row.key).pipe(
          Effect.andThen(options.handles.finish(row.id)),
          Effect.as(true),
          Effect.catch(() =>
            Effect.logWarning(
              "An expired file could not be removed; the next sweep retries it",
            ).pipe(Effect.annotateLogs({ "executor.file_handle.id": row.id }), Effect.as(false)),
          ),
        );
        if (done) removed += 1;
      }
      if (claimed.length < batch) break;
    }
    return removed;
  }).pipe(Effect.withSpan("sdk.file_handles.sweep"));

/** The sweep on a schedule, for products that run their own background work. Never ends or fails. */
export const fileHandleSweepLoop = (options: {
  readonly handles: FileHandleStore;
  readonly store: BlobStorage;
  readonly every: Schedule.Schedule<unknown>;
}) =>
  sweepFileHandles(options).pipe(
    Effect.catch(() => Effect.logWarning("File handle sweep failed")),
    Effect.repeat(options.every),
  );
