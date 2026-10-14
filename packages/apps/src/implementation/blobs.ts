/** The author API for `ctx.blobs` and the adapter over the host's transfer callback. */
import { Effect, Result, Schema, type Context } from "effect";
import { Base64 } from "effect/encoding";
import {
  BlobCommand,
  BlobHandle,
  BlobLimits,
  BlobReply,
  BlobUnavailable,
  BlobUpstreamFailed,
  maxBlobRequestBodyBytes,
  type AppBlobs,
  type BlobError,
  type BlobFetchInit,
  type BlobReference,
  type HostBlobs,
} from "../contracts/blobs.ts";
import { toPromise } from "./authoring.ts";

const unavailable = Effect.fail(new BlobUnavailable());

/** Missing host support is explicit on use; ordinary apps do not need files. */
export const unavailableBlobs: HostBlobs = {
  limits: unavailable,
  fromUrl: () => unavailable,
  create: () => unavailable,
  stat: () => unavailable,
  read: () => unavailable,
  delete: () => unavailable,
};

const referenceId = (reference: BlobReference) => reference.id;

/** Bind the host's blob operations to an invocation's cancellation and telemetry. */
export const authorBlobs = (
  host: HostBlobs,
  signal: AbortSignal,
  telemetry: Context.Context<never>,
): AppBlobs => ({
  limits: toPromise(() => host.limits, signal, telemetry),
  fromUrl: toPromise(
    (url: string, init?: BlobFetchInit) =>
      Effect.suspend(() =>
        init?.body !== undefined &&
        new TextEncoder().encode(init.body).byteLength > maxBlobRequestBodyBytes
          ? Effect.fail(new BlobUpstreamFailed({ reason: "request" }))
          : host.fromUrl(url, init ?? {}),
      ),
    signal,
    telemetry,
  ),
  create: toPromise(
    (bytes: Uint8Array, options?: { readonly contentType?: string }) =>
      host.create(bytes, options ?? {}),
    signal,
    telemetry,
  ),
  stat: toPromise((handle: BlobReference) => host.stat(referenceId(handle)), signal, telemetry),
  read: toPromise(
    (handle: BlobHandle, range: { readonly offset: number; readonly length: number }) =>
      host.read(handle, range),
    signal,
    telemetry,
  ),
  delete: toPromise((handle: BlobReference) => host.delete(referenceId(handle)), signal, telemetry),
});

/**
 * Adapt the host's transfer callback, which a generated entry hands the framework as a plain
 * function, into `HostBlobs`. A transport failure reads as `BlobUnavailable`: raw failures never
 * reach app code.
 */
export const isolatedBlobs = (deliver: (request: unknown) => Promise<unknown>): HostBlobs => {
  const send = (command: BlobCommand) =>
    // oxlint-disable-next-line executor/authored-code-through-adapter -- the host's blob RPC
    Effect.tryPromise({
      try: () => deliver(Schema.encodeSync(BlobCommand)(command)),
      catch: () => new BlobUnavailable(),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(BlobReply)),
      Effect.mapError((error): BlobError =>
        Schema.is(BlobUnavailable)(error) ? error : new BlobUnavailable(),
      ),
      Effect.flatMap((reply) =>
        reply.ok ? Effect.succeed(reply.value) : Effect.fail(reply.error),
      ),
    );
  const decode =
    <A, I>(schema: Schema.Codec<A, I>) =>
    (value: unknown) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => new BlobUnavailable()));
  return {
    limits: send({ op: "limits" }).pipe(Effect.flatMap(decode(BlobLimits))),
    fromUrl: (url, init) =>
      send({
        op: "fromUrl",
        url,
        ...(init.method === undefined ? {} : { method: init.method }),
        ...(init.headers === undefined ? {} : { headers: { ...init.headers } }),
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.contentType === undefined ? {} : { contentType: init.contentType }),
        ...(init.expectedSize === undefined ? {} : { expectedSize: init.expectedSize }),
        ...(init.expectedSha256 === undefined ? {} : { expectedSha256: init.expectedSha256 }),
      }).pipe(Effect.flatMap(decode(BlobHandle))),
    create: (bytes, options) =>
      send({
        op: "create",
        bytes: Base64.encode(bytes),
        ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
      }).pipe(Effect.flatMap(decode(BlobHandle))),
    stat: (id) => send({ op: "stat", id }).pipe(Effect.flatMap(decode(BlobHandle))),
    read: (handle, range) =>
      send({ op: "read", handle, offset: range.offset, length: range.length }).pipe(
        Effect.flatMap(decode(Schema.String)),
        Effect.flatMap((text) =>
          Result.match(Base64.decode(text), {
            onFailure: () => Effect.fail(new BlobUnavailable()),
            onSuccess: Effect.succeed,
          }),
        ),
      ),
    delete: (id) => send({ op: "delete", id }).pipe(Effect.asVoid),
  };
};
