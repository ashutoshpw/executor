/**
 * The life of one file transfer into the user-content store, shared by every way bytes arrive: the
 * runner's host-side fetch (`ctx.blobs.fromUrl`) and an upload over HTTP. A transfer is a
 * reservation the product made (`begun`), the stream into the store, hashing and counting on the
 * way, and a commit the product verifies, dedupes and publishes.
 *
 * A failure before the commit is sent removes the object and drops the reservation. Once the
 * commit is sent its outcome can be unknown, so a failure that does not say the product refused it
 * leaves both alone: a published file keeps its object, and an unpublished reservation expires into
 * the product's sweep, which removes both. A running transfer renews its reservation, so the sweep
 * only ever finds abandoned ones.
 */
import { Effect, Exit, Schema, Stream } from "effect";
import {
  BlobError,
  BlobIntegrityError,
  BlobNotFound,
  BlobTooLarge,
  BlobUnavailable,
  type BlobHandle,
} from "apps/contracts";
import type { BlobKey, BlobStorage } from "../contracts/blobs.ts";
import type { BlobBegun, StreamingSha256 } from "../contracts/file-handles.ts";

/** What the transfer asks of the product, however it reaches it. */
export interface TransferPorts {
  /** Publish the reservation; the product verifies, dedupes and may refuse. */
  readonly commit: (input: {
    readonly id: string;
    readonly size: number;
    readonly sha256: string;
  }) => Effect.Effect<{ readonly handle: BlobHandle; readonly deduped: boolean }, BlobError>;
  /** Keep the reservation alive for another period. A failure is ignored: the next renewal retries. */
  readonly touch: (id: string) => Effect.Effect<unknown, unknown>;
  /** Drop a reservation that was never committed. */
  readonly abort: (id: string) => Effect.Effect<unknown, unknown>;
}

export interface StoredTransfer {
  readonly begun: BlobBegun;
  readonly store: BlobStorage;
  readonly hasher: () => StreamingSha256;
  readonly source: Stream.Stream<Uint8Array, BlobError>;
  readonly ports: TransferPorts;
  /**
   * Runs before any byte is read. It refuses a transfer that cannot succeed, and returns the exact
   * size the store is promised when the sender knows it.
   */
  readonly declare: Effect.Effect<number | undefined, BlobError>;
  /** The most bytes the transfer may hold; `begun.maxFileBytes` when absent. */
  readonly limit?: number | undefined;
  /** What the stored bytes must match, else the transfer is discarded. */
  readonly expected?: { readonly size?: number | undefined; readonly sha256?: string | undefined };
  /** Runs when the transfer fails, such as releasing the source. */
  readonly release?: Effect.Effect<void>;
}

/** Store the transfer's bytes and publish them. Fails with a typed `BlobError`, leaving nothing behind. */
export const storeTransfer = (transfer: StoredTransfer): Effect.Effect<BlobHandle, BlobError> => {
  const { begun, store, ports } = transfer;
  const key = begun.key as BlobKey;
  const limit = transfer.limit ?? begun.maxFileBytes;
  const removeObject = store
    .remove(key)
    .pipe(Effect.catch(() => Effect.logWarning("A file transfer's object could not be removed")));
  /** Undo a transfer that did not commit: no object, no reservation. */
  const discard = removeObject.pipe(
    Effect.andThen(
      ports
        .abort(begun.id)
        .pipe(
          Effect.catch(() => Effect.logWarning("A file transfer's reservation was not dropped")),
        ),
    ),
  );
  // `sent` once the commit may have reached the product; `refused` once it said no.
  let commit: "none" | "sent" | "refused" = "none";
  const run = Effect.gen(function* () {
    const declared = yield* transfer.declare;
    const digest = transfer.hasher();
    let counted = 0;
    const written = yield* store
      .putStream(
        key,
        transfer.source.pipe(
          Stream.mapEffect((chunk) =>
            Effect.suspend((): Effect.Effect<Uint8Array, BlobError> => {
              counted += chunk.byteLength;
              if (counted > limit) return Effect.fail(new BlobTooLarge({ maximum: limit }));
              return Effect.tryPromise({
                try: () => digest.write(chunk),
                catch: () => new BlobUnavailable(),
              }).pipe(Effect.as(chunk));
            }),
          ),
        ),
        declared === undefined ? {} : { size: declared },
      )
      .pipe(
        Effect.mapError((error): BlobError =>
          Schema.is(BlobError)(error)
            ? error
            : // The store refuses a stream whose length differs from the declared size.
              declared !== undefined && counted !== declared
              ? new BlobIntegrityError({ reason: "size" })
              : new BlobUnavailable(),
        ),
        Effect.map(() => counted),
      );
    const expected = transfer.expected;
    if (expected?.size !== undefined && written !== expected.size)
      return yield* new BlobIntegrityError({ reason: "size" });
    const hash = yield* Effect.tryPromise({
      try: () => digest.finish(),
      catch: () => new BlobUnavailable(),
    });
    if (expected?.sha256 !== undefined && expected.sha256.toLowerCase() !== hash)
      return yield* new BlobIntegrityError({ reason: "sha256" });
    commit = "sent";
    const committed = yield* ports.commit({ id: begun.id, size: written, sha256: hash }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (Schema.is(BlobNotFound)(error) || Schema.is(BlobTooLarge)(error)) commit = "refused";
        }),
      ),
    );
    // The owner already held these bytes: the surviving handle's object is not this one.
    if (committed.deduped) yield* removeObject;
    return committed.handle;
  });
  // The reservation stays alive for as long as the transfer runs, however slow the sender.
  const renewal = ports
    .touch(begun.id)
    .pipe(Effect.ignore, Effect.delay(`${begun.renewSeconds} seconds`), Effect.forever);
  return Effect.raceFirst(run, renewal).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : Effect.andThen(
            transfer.release ?? Effect.void,
            // An unconfirmed commit may have published the file; its object is not ours to remove.
            commit === "sent" ? Effect.void : discard,
          ),
    ),
  );
};
