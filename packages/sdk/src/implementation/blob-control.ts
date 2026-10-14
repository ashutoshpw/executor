/**
 * The product's side of one invocation's file operations. The runner streams bytes into the
 * user-content store itself; everything that needs authority, which is every question about who
 * owns a file, how large it may be and how long it lives, is asked here. The owner and app come
 * from the trusted invocation, never from the command.
 */
import { Cause, Effect, Schema } from "effect";
import {
  BlobError,
  BlobIntegrityError,
  BlobLimits,
  BlobNotFound,
  BlobReply,
  BlobTooLarge,
  BlobUnavailable,
} from "apps/contracts";
import {
  BlobBegun,
  BlobCommitted,
  BlobControlCommand,
  BlobStatted,
  type UserContentOptions,
} from "../contracts/file-handles.ts";

/** One invocation's control surface: a command in, the encoded reply out. It never fails. */
export type BlobControl = (input: unknown) => Effect.Effect<unknown>;

const sha256Pattern = /^[0-9a-f]{64}$/;

/** Control for an invocation of `app`, owned by `owner`. */
export const makeBlobControl = (options: {
  readonly userContent: UserContentOptions;
  readonly app: string;
  readonly owner: Effect.Effect<string, BlobUnavailable>;
}): BlobControl => {
  const { store, handles, policy } = options.userContent;
  const limits = (owner: string) =>
    policy.ttlSeconds(owner).pipe(
      Effect.map((ttlSeconds) =>
        BlobLimits.make({
          maxFileBytes: policy.maxFileBytes,
          maxInlineBytes: policy.maxInlineBytes,
          maxReadBytes: policy.maxReadBytes,
          methods: [...policy.methods],
          ttlSeconds,
        }),
      ),
    );
  const run = (command: BlobControlCommand): Effect.Effect<Schema.Json, BlobError> =>
    Effect.gen(function* () {
      const owner = yield* options.owner;
      switch (command.op) {
        case "limits":
          return yield* Schema.encodeEffect(BlobLimits)(yield* limits(owner)).pipe(Effect.orDie);
        case "begin": {
          const pending = yield* handles.begin({
            owner,
            appId: options.app,
            contentType: command.contentType,
          });
          return yield* Schema.encodeEffect(BlobBegun)({
            id: pending.id,
            key: pending.key,
            maxFileBytes: policy.maxFileBytes,
            maxInlineBytes: policy.maxInlineBytes,
            requiresSize: policy.requiresSize,
          }).pipe(Effect.orDie);
        }
        case "commit": {
          if (!sha256Pattern.test(command.sha256))
            return yield* new BlobIntegrityError({ reason: "sha256" });
          if (command.size > policy.maxFileBytes)
            return yield* new BlobTooLarge({
              maximum: policy.maxFileBytes,
              requested: command.size,
            });
          const committed = yield* handles.commit({
            owner,
            id: command.id,
            size: command.size,
            sha256: command.sha256,
            maxFileBytes: policy.maxFileBytes,
            ttlSeconds: yield* policy.ttlSeconds(owner),
          });
          return yield* Schema.encodeEffect(BlobCommitted)(committed).pipe(Effect.orDie);
        }
        case "abort":
          yield* handles.abort({ owner, id: command.id });
          return null;
        case "stat": {
          const found = yield* handles.stat({ owner, id: command.id });
          return yield* Schema.encodeEffect(BlobStatted)({
            handle: found.handle,
            key: found.key,
            maxReadBytes: policy.maxReadBytes,
          }).pipe(Effect.orDie);
        }
        case "delete": {
          const claimed = yield* handles.retire({ owner, id: command.id, appId: options.app });
          // A failed removal leaves the retired row for the sweep, which retries it.
          yield* store.remove(claimed.key).pipe(
            Effect.andThen(handles.finish(claimed.id)),
            Effect.catch(() =>
              Effect.logWarning("A deleted file's object could not be removed yet"),
            ),
          );
          return null;
        }
      }
    });
  return (input) =>
    Schema.decodeUnknownEffect(BlobControlCommand)(input).pipe(
      Effect.mapError((): BlobError => new BlobNotFound({ id: "" })),
      Effect.flatMap(run),
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.interrupt;
        const error = Cause.squash(cause);
        return Effect.succeed({
          ok: false as const,
          error: Schema.is(BlobError)(error) ? error : new BlobUnavailable(),
        });
      }),
      Effect.flatMap(Schema.encodeEffect(BlobReply)),
      Effect.orDie,
    );
};
