/**
 * The runner's side of one invocation's file operations. It is the only place file bytes move:
 * a `fromUrl` fetch runs here, through the app's own outbound network (credential handles, host
 * pinning and private-address refusal unchanged), and its body streams straight into the
 * user-content store, hashing on the way. The bytes never reach the app's isolate or the product.
 * Questions of ownership, size limits and lifetime go to the product through `control`.
 *
 * A transfer is `begin` (the product reserves a handle and an object key), the stream, `commit`
 * (the product verifies, dedupes and publishes). Any failure removes the object and drops the
 * reservation; the product's sweep removes what a crash leaves.
 */
import type { Fetcher } from "@cloudflare/workers-types";
import { Cause, Effect, Exit, Result, Schema, Stream } from "effect";
import { Base64, Hex } from "effect/encoding";
import {
  BlobError,
  BlobHandle,
  BlobIntegrityError,
  BlobLimits,
  BlobNotFound,
  BlobRangeInvalid,
  BlobReply,
  BlobTooLarge,
  BlobUnavailable,
  BlobUpstreamFailed,
  maxBlobRequestBodyBytes,
  BlobCommand,
} from "apps/contracts";
import type { BlobKey, BlobStorage } from "../contracts/blobs.ts";
import {
  BlobBegun,
  BlobCommitted,
  BlobStatted,
  type BlobControlCommand,
} from "../contracts/file-handles.ts";

const redirectLimit = 5;
const defaultContentType = "application/octet-stream";

interface Sha256 {
  readonly write: (chunk: Uint8Array) => Promise<void>;
  readonly finish: () => Promise<string>;
}
/** workerd's streaming digest: the runner always runs in workerd, whatever product hosts it. */
interface DigestStreamConstructor {
  new (algorithm: string): WritableStream<Uint8Array> & { readonly digest: Promise<ArrayBuffer> };
}
const sha256 = (): Sha256 => {
  // SAFETY: `DigestStream` is a workerd extension of the global `crypto`, absent from DOM typings.
  const { DigestStream } = crypto as unknown as { DigestStream: DigestStreamConstructor };
  const stream = new DigestStream("SHA-256");
  const writer = stream.getWriter();
  return {
    write: (chunk) => writer.write(chunk),
    finish: async () => {
      await writer.close();
      return Hex.encode(new Uint8Array(await stream.digest));
    },
  };
};

/** One transfer's operations over the product's control callback and the user-content store. */
export const blobTransfer = (options: {
  readonly control: (input: unknown) => Promise<unknown>;
  readonly store: BlobStorage;
  readonly outbound: Pick<Fetcher, "fetch">;
  readonly signal: AbortSignal;
}): ((input: unknown) => Promise<unknown>) => {
  const { store, outbound } = options;

  /** Ask the product; its typed failures pass through, anything else is `BlobUnavailable`. */
  const ask = <A, I>(schema: Schema.Codec<A, I>, command: BlobControlCommand) =>
    Effect.tryPromise({
      try: () => options.control(command),
      catch: () => new BlobUnavailable(),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(BlobReply)),
      Effect.mapError((error): BlobError =>
        Schema.is(BlobError)(error) ? error : new BlobUnavailable(),
      ),
      Effect.flatMap((reply) =>
        reply.ok ? Effect.succeed(reply.value) : Effect.fail(reply.error),
      ),
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError((error): BlobError =>
        Schema.is(BlobError)(error) ? error : new BlobUnavailable(),
      ),
    );

  const removeObject = (key: BlobKey) =>
    store
      .remove(key)
      .pipe(Effect.catch(() => Effect.logWarning("A file transfer's object could not be removed")));
  /** Undo a transfer that did not commit: no object, no reservation. */
  const discard = (id: string, key: BlobKey) =>
    removeObject(key).pipe(
      Effect.andThen(
        ask(Schema.Null, { op: "abort", id }).pipe(
          Effect.catch(() => Effect.logWarning("A file transfer's reservation was not dropped")),
        ),
      ),
    );

  const parseUrl = (value: string) =>
    Result.match(
      Result.try(() => new URL(value)),
      {
        onFailure: () => Effect.fail(new BlobUpstreamFailed({ reason: "request" })),
        onSuccess: (url) =>
          url.protocol === "https:" || url.protocol === "http:"
            ? Effect.succeed(url)
            : Effect.fail(new BlobUpstreamFailed({ reason: "request" })),
      },
    );

  /** The request, following redirects hop by hop so each one passes the outbound network's rules. */
  const fetchFollowing = (command: Extract<BlobCommand, { op: "fromUrl" }>) =>
    Effect.gen(function* () {
      if (
        command.body !== undefined &&
        new TextEncoder().encode(command.body).byteLength > maxBlobRequestBodyBytes
      )
        return yield* new BlobUpstreamFailed({ reason: "request" });
      let url = yield* parseUrl(command.url);
      let method = (command.method ?? "GET").toUpperCase();
      let body = command.body;
      for (let hop = 0; hop <= redirectLimit; hop += 1) {
        const response = yield* Effect.tryPromise({
          try: () =>
            outbound.fetch(url.href, {
              method,
              headers: { ...command.headers },
              redirect: "manual",
              ...(body === undefined || method === "GET" || method === "HEAD" ? {} : { body }),
              signal: options.signal as never,
            }),
          catch: () => new BlobUpstreamFailed({ reason: "transport" }),
        });
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location !== null) {
          yield* discardBody(response);
          url = yield* parseUrl(new URL(location, url).href);
          if (response.status !== 307 && response.status !== 308) {
            method = "GET";
            body = undefined;
          }
          continue;
        }
        return response;
      }
      return yield* new BlobUpstreamFailed({ reason: "status", status: 310 });
    });

  /** Release a response's body; one already read, or locked by a reader, has nothing to release. */
  const discardBody = (response: Awaited<ReturnType<Fetcher["fetch"]>>) =>
    Effect.tryPromise({
      try: () => response.body?.cancel() ?? Promise.resolve(),
      catch: () => undefined,
    }).pipe(Effect.ignore);

  const hasKnownLength = (response: Awaited<ReturnType<Fetcher["fetch"]>>) => {
    // A compressed answer's Content-Length is not the length of the bytes the body yields.
    const encoding = response.headers.get("content-encoding");
    if (encoding !== null && encoding.toLowerCase() !== "identity") return undefined;
    const length = response.headers.get("content-length");
    if (length === null || !/^\d+$/.test(length)) return undefined;
    return Number(length);
  };

  const fromUrl = (command: Extract<BlobCommand, { op: "fromUrl" }>) =>
    Effect.gen(function* () {
      const response = yield* fetchFollowing(command);
      const cancel = discardBody(response);
      if (response.status < 200 || response.status >= 300) {
        yield* cancel;
        return yield* new BlobUpstreamFailed({ reason: "status", status: response.status });
      }
      const contentType =
        command.contentType ?? response.headers.get("content-type") ?? defaultContentType;
      const begun = yield* ask(BlobBegun, { op: "begin", contentType }).pipe(
        Effect.onError(() => cancel),
      );
      const key = begun.key as BlobKey;
      const transfer = Effect.gen(function* () {
        const length = hasKnownLength(response);
        if (length !== undefined && length > begun.maxFileBytes)
          return yield* new BlobTooLarge({ maximum: begun.maxFileBytes, requested: length });
        if (command.expectedSize !== undefined) {
          if (command.expectedSize > begun.maxFileBytes)
            return yield* new BlobTooLarge({
              maximum: begun.maxFileBytes,
              requested: command.expectedSize,
            });
          if (length !== undefined && length !== command.expectedSize)
            return yield* new BlobIntegrityError({ reason: "size" });
        }
        const declared = command.expectedSize ?? length;
        if (declared === undefined && begun.requiresSize)
          return yield* new BlobUpstreamFailed({ reason: "length-required" });
        const digest = sha256();
        let counted = 0;
        const body = response.body;
        const source: Stream.Stream<Uint8Array, BlobError> =
          body === null
            ? Stream.empty
            : Stream.fromReadableStream({
                // SAFETY: workerd's ReadableStream is the global one under another declaration.
                evaluate: () => body as unknown as ReadableStream<Uint8Array>,
                onError: (): BlobError => new BlobUpstreamFailed({ reason: "transport" }),
              });
        const written = yield* store
          .putStream(
            key,
            source.pipe(
              Stream.mapEffect((chunk) =>
                Effect.suspend((): Effect.Effect<Uint8Array, BlobError> => {
                  counted += chunk.byteLength;
                  if (counted > begun.maxFileBytes)
                    return Effect.fail(new BlobTooLarge({ maximum: begun.maxFileBytes }));
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
        if (command.expectedSize !== undefined && written !== command.expectedSize)
          return yield* new BlobIntegrityError({ reason: "size" });
        const hash = yield* Effect.tryPromise({
          try: () => digest.finish(),
          catch: () => new BlobUnavailable(),
        });
        if (command.expectedSha256 !== undefined && command.expectedSha256.toLowerCase() !== hash)
          return yield* new BlobIntegrityError({ reason: "sha256" });
        const committed = yield* ask(BlobCommitted, {
          op: "commit",
          id: begun.id,
          size: written,
          sha256: hash,
        });
        // The owner already held these bytes: the surviving handle's object is not this one.
        if (committed.deduped) yield* removeObject(key);
        return committed.handle;
      });
      return yield* transfer.pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : Effect.andThen(cancel, discard(begun.id, key)),
        ),
      );
    });

  const create = (command: Extract<BlobCommand, { op: "create" }>) =>
    Effect.gen(function* () {
      const bytes = yield* Result.match(Base64.decode(command.bytes), {
        onFailure: () => Effect.fail(new BlobUpstreamFailed({ reason: "request" })),
        onSuccess: Effect.succeed,
      });
      const begun = yield* ask(BlobBegun, {
        op: "begin",
        contentType: command.contentType ?? defaultContentType,
      });
      const key = begun.key as BlobKey;
      return yield* Effect.gen(function* () {
        if (bytes.byteLength > begun.maxInlineBytes)
          return yield* new BlobTooLarge({
            maximum: begun.maxInlineBytes,
            requested: bytes.byteLength,
          });
        const hash = Hex.encode(
          new Uint8Array(
            yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes as BufferSource)),
          ),
        );
        yield* store
          .putStream(key, Stream.make(bytes), { size: bytes.byteLength })
          .pipe(Effect.mapError(() => new BlobUnavailable()));
        const committed = yield* ask(BlobCommitted, {
          op: "commit",
          id: begun.id,
          size: bytes.byteLength,
          sha256: hash,
        });
        if (committed.deduped) yield* removeObject(key);
        return committed.handle;
      }).pipe(
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : discard(begun.id, key))),
      );
    });

  const read = (command: Extract<BlobCommand, { op: "read" }>) =>
    Effect.gen(function* () {
      const found = yield* ask(BlobStatted, { op: "stat", id: command.handle.id });
      if (
        found.handle.sha256 !== command.handle.sha256 ||
        found.handle.size !== command.handle.size
      )
        return yield* new BlobIntegrityError({ reason: "handle" });
      if (command.offset < 0 || command.length < 0 || command.length > found.maxReadBytes)
        return yield* new BlobRangeInvalid({ maximum: found.maxReadBytes });
      if (command.offset >= found.handle.size || command.length === 0) return "";
      const body = yield* store
        .stream(found.key as BlobKey, { offset: command.offset, length: command.length })
        .pipe(Effect.mapError(() => new BlobUnavailable()));
      if (body._tag === "None") return yield* new BlobNotFound({ id: command.handle.id });
      const chunks = yield* Stream.runCollect(body.value.body).pipe(
        Effect.mapError(() => new BlobUnavailable()),
      );
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      return Base64.encode(bytes);
    });

  const run = (command: BlobCommand): Effect.Effect<Schema.Json, BlobError> => {
    switch (command.op) {
      case "limits":
        return ask(BlobLimits, { op: "limits" }).pipe(
          Effect.flatMap(Schema.encodeEffect(BlobLimits)),
          Effect.mapError(() => new BlobUnavailable()),
        );
      case "fromUrl":
        return fromUrl(command).pipe(encodeHandle);
      case "create":
        return create(command).pipe(encodeHandle);
      case "stat":
        return ask(BlobStatted, { op: "stat", id: command.id }).pipe(
          Effect.map((found) => found.handle),
          encodeHandle,
        );
      case "read":
        return read(command);
      case "delete":
        return ask(Schema.Null, { op: "delete", id: command.id });
    }
  };
  const encodeHandle = <E>(effect: Effect.Effect<typeof BlobHandle.Type, E>) =>
    effect.pipe(
      Effect.flatMap((handle) =>
        Schema.encodeEffect(BlobHandle)(handle).pipe(Effect.mapError(() => new BlobUnavailable())),
      ),
    );

  return (input) =>
    Effect.runPromise(
      Schema.decodeUnknownEffect(BlobCommand)(input).pipe(
        Effect.mapError((): BlobError => new BlobUnavailable()),
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
      ),
      { signal: options.signal },
    );
};
