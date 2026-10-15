/**
 * The runner's side of one invocation's file operations. It is the only place file bytes move:
 * a `fromUrl` fetch runs here, through the app's own outbound network (credential handles, host
 * pinning and private-address refusal unchanged), and its body streams straight into the
 * user-content store, hashing on the way. The bytes never reach the app's isolate or the product.
 * Questions of ownership, size limits and lifetime go to the product through `control`.
 *
 * A transfer is `begin` (the product reserves a handle and an object key), the stream, `commit`
 * (the product verifies, dedupes and publishes). A failure before the commit is sent removes the
 * object and drops the reservation. Once the commit is sent its outcome can be unknown, so a
 * failure that does not say the product refused it leaves both alone: a published file keeps its
 * object, and an unpublished reservation expires into the product's sweep, which removes both.
 * A running transfer renews its reservation, so the sweep only ever finds abandoned ones.
 */
import type { Fetcher } from "@cloudflare/workers-types";
import { Cause, Effect, Exit, Result, Schema, Stream } from "effect";
import { Base64, Hex } from "effect/encoding";
import {
  BlobError,
  BlobHandle,
  BlobIntegrityError,
  BlobLimits,
  BlobLink,
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
import { digestStreamSha256 } from "./digest-stream.ts";
import { storeTransfer } from "./stored-transfer.ts";

const redirectLimit = 5;
const defaultContentType = "application/octet-stream";
/** Headers that carry the caller's credentials; a redirect to another origin drops them. */
const crossOriginStripped = new Set(["authorization", "cookie", "proxy-authorization"]);

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
      let headers: Record<string, string> = { ...command.headers };
      for (let hop = 0; hop <= redirectLimit; hop += 1) {
        const response = yield* Effect.tryPromise({
          try: () =>
            outbound.fetch(url.href, {
              method,
              headers,
              redirect: "manual",
              ...(body === undefined || method === "GET" || method === "HEAD" ? {} : { body }),
              signal: options.signal as never,
            }),
          catch: () => new BlobUpstreamFailed({ reason: "transport" }),
        });
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location !== null) {
          yield* discardBody(response);
          const next = yield* parseUrl(new URL(location, url).href);
          if (response.status !== 307 && response.status !== 308) {
            method = "GET";
            body = undefined;
          }
          // As `fetch` does, a redirect to another origin leaves the caller's credentials and body
          // behind.
          if (next.origin !== url.origin) {
            headers = Object.fromEntries(
              Object.entries(headers).filter(
                ([name]) => !crossOriginStripped.has(name.toLowerCase()),
              ),
            );
            body = undefined;
          }
          url = next;
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
      const body = response.body;
      return yield* storeTransfer({
        begun,
        store,
        hasher: digestStreamSha256,
        source:
          body === null
            ? Stream.empty
            : Stream.fromReadableStream({
                // SAFETY: workerd's ReadableStream is the global one under another declaration.
                evaluate: () => body as unknown as ReadableStream<Uint8Array>,
                onError: (): BlobError => new BlobUpstreamFailed({ reason: "transport" }),
              }),
        ports: {
          commit: (input) => ask(BlobCommitted, { op: "commit", ...input }),
          touch: (id) => ask(Schema.Null, { op: "touch", id }),
          abort: (id) => ask(Schema.Null, { op: "abort", id }),
        },
        declare: Effect.gen(function* () {
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
          return declared;
        }),
        expected: { size: command.expectedSize, sha256: command.expectedSha256 },
        release: cancel,
      });
    });

  const create = (command: Extract<BlobCommand, { op: "create" }>) =>
    Effect.gen(function* () {
      const begun = yield* ask(BlobBegun, {
        op: "begin",
        contentType: command.contentType ?? defaultContentType,
      });
      const key = begun.key as BlobKey;
      let commit: "none" | "sent" | "refused" = "none";
      return yield* Effect.gen(function* () {
        // Padded base64 spells n bytes in 4 * ceil(n / 3) characters: refuse longer input before
        // decoding it, so an oversized request never allocates its bytes.
        const encodedLimit = Math.ceil(begun.maxInlineBytes / 3) * 4;
        if (command.bytes.length > encodedLimit)
          return yield* new BlobTooLarge({ maximum: begun.maxInlineBytes });
        const bytes = yield* Result.match(Base64.decode(command.bytes), {
          onFailure: () => Effect.fail(new BlobUpstreamFailed({ reason: "request" })),
          onSuccess: Effect.succeed,
        });
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
        commit = "sent";
        const committed = yield* ask(BlobCommitted, {
          op: "commit",
          id: begun.id,
          size: bytes.byteLength,
          sha256: hash,
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (Schema.is(BlobNotFound)(error) || Schema.is(BlobTooLarge)(error))
                commit = "refused";
            }),
          ),
        );
        if (committed.deduped) yield* removeObject(key);
        return committed.handle;
      }).pipe(
        // An unconfirmed commit may have published the file; its object is not ours to remove.
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) || commit === "sent" ? Effect.void : discard(begun.id, key),
        ),
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
      case "url":
        // A link is a URL, never bytes: the product signs it and the runner passes it through.
        return ask(BlobLink, {
          op: "url",
          id: command.id,
          ...(command.expiresInSeconds === undefined
            ? {}
            : { expiresInSeconds: command.expiresInSeconds }),
          ...(command.filename === undefined ? {} : { filename: command.filename }),
        }).pipe(
          Effect.flatMap((link) =>
            Schema.encodeEffect(BlobLink)(link).pipe(Effect.mapError(() => new BlobUnavailable())),
          ),
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
