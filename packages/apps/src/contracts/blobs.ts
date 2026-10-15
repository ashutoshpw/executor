/**
 * File handles. An app moves file bytes into the host's user-content store and keeps only a small
 * handle: the bytes never travel in a tool result, and a fetch's bytes never enter the app's
 * isolate. Handles are immutable and content-addressed, shared per organization, and expire.
 */
import { Schema, type Effect } from "effect";

/** What a tool returns for a stored file. Every field is required, so approvals bind the whole value. */
export const BlobHandle = Schema.Struct({
  /** Opaque and unguessable; only the organization that created the handle can use it. */
  id: Schema.String,
  /** Lowercase hex SHA-256 of the file's bytes. */
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  contentType: Schema.String,
  /** ISO-8601 time after which the host deletes the file. */
  expiresAt: Schema.String,
});
export type BlobHandle = typeof BlobHandle.Type;

/**
 * A short-lived link that downloads a file with an ordinary HTTP GET, with no other credential.
 * It serves byte ranges, so a download manager can resume it.
 */
export const BlobLink = Schema.Struct({
  url: Schema.String,
  /** ISO-8601 time after which the link stops working. */
  expiresAt: Schema.String,
});
export type BlobLink = typeof BlobLink.Type;

/** What `url` accepts. Both fields are optional. */
export interface BlobLinkOptions {
  /** How long the link works, in seconds. The host clamps it to what it allows, at least 60. */
  readonly expiresInSeconds?: number;
  /** The file name a browser saves the download as. */
  readonly filename?: string;
}

/** What this host stores. Apps check it before they transfer a file. */
export const BlobLimits = Schema.Struct({
  /** The largest file this host stores. */
  maxFileBytes: Schema.Int,
  /** The largest `create` input. */
  maxInlineBytes: Schema.Int,
  /** The most bytes one `read` returns. */
  maxReadBytes: Schema.Int,
  methods: Schema.Array(Schema.Literals(["fromUrl", "create", "read", "url"])),
  /** How long a new handle lives in this organization. */
  ttlSeconds: Schema.Int,
});
export type BlobLimits = typeof BlobLimits.Type;

/** The file, or the request's declared size, is larger than this host stores. */
export class BlobTooLarge extends Schema.TaggedError<BlobTooLarge>()("BlobTooLarge", {
  maximum: Schema.Int,
  /** Absent when the file turned out larger while it was streaming. */
  requested: Schema.optionalKey(Schema.Int),
}) {}
/** The handle does not exist for this organization, or it has expired and been removed. */
export class BlobNotFound extends Schema.TaggedError<BlobNotFound>()("BlobNotFound", {
  id: Schema.String,
}) {}
/** The handle's lifetime ended; the host has not removed it yet. */
export class BlobExpired extends Schema.TaggedError<BlobExpired>()("BlobExpired", {
  id: Schema.String,
}) {}
/** The bytes or the handle disagree with what was expected. */
export class BlobIntegrityError extends Schema.TaggedError<BlobIntegrityError>()(
  "BlobIntegrityError",
  {
    reason: Schema.Literals(["size", "sha256", "handle"]),
  },
) {}
/** The upstream answered a fetch with a failure, or could not be read. */
export class BlobUpstreamFailed extends Schema.TaggedError<BlobUpstreamFailed>()(
  "BlobUpstreamFailed",
  {
    reason: Schema.Literals(["status", "length-required", "transport", "request"]),
    status: Schema.optionalKey(Schema.Int),
  },
) {}
/** The requested range is not readable in one call. */
export class BlobRangeInvalid extends Schema.TaggedError<BlobRangeInvalid>()("BlobRangeInvalid", {
  maximum: Schema.Int,
}) {}
/** The host stores no files for this invocation, or its store failed. */
export class BlobUnavailable extends Schema.TaggedError<BlobUnavailable>()("BlobUnavailable", {}) {}

/** Every failure a blob operation reports. */
export const BlobError = Schema.Union([
  BlobTooLarge,
  BlobNotFound,
  BlobExpired,
  BlobIntegrityError,
  BlobUpstreamFailed,
  BlobRangeInvalid,
  BlobUnavailable,
]);
export type BlobError = typeof BlobError.Type;

/** The most `fromUrl` sends as a request body. */
export const maxBlobRequestBodyBytes = 64 * 1024;

/** Options of a host-side fetch. `headers` may carry sealed account handles, as `ctx.fetch` does. */
export interface BlobFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** A text request body, at most 64 KiB. */
  readonly body?: string;
  readonly contentType?: string;
  /** The exact size the file must have; required on a host that cannot stream an unknown length. */
  readonly expectedSize?: number;
  /** The SHA-256 the file must have; a different file is discarded. */
  readonly expectedSha256?: string;
}

/** The reference a caller names an existing file with. */
export type BlobReference = BlobHandle | { readonly id: string };

/** `ctx.blobs`: files by handle, with Promise methods for app authors. */
export interface AppBlobs {
  /** What this host stores. Check `maxFileBytes` before a transfer. */
  readonly limits: () => Promise<BlobLimits>;
  /**
   * Fetch a URL and store the response body. The host makes the request, with the app's network
   * rules and credential handles, and streams the body into the store: the bytes never enter the
   * app. Fails with `BlobUpstreamFailed` for a non-2xx answer.
   */
  readonly fromUrl: (url: string, init?: BlobFetchInit) => Promise<BlobHandle>;
  /** Store bytes the app already holds, at most `maxInlineBytes`. */
  readonly create: (
    bytes: Uint8Array,
    options?: { readonly contentType?: string },
  ) => Promise<BlobHandle>;
  /** The handle as the host knows it: the same file, its current expiry. */
  readonly stat: (handle: BlobReference) => Promise<BlobHandle>;
  /** `length` bytes from `offset`, at most `maxReadBytes`; a range past the end is clamped. */
  readonly read: (
    handle: BlobHandle,
    range: { readonly offset: number; readonly length: number },
  ) => Promise<Uint8Array>;
  /**
   * A link that downloads the file over HTTPS, to give to a person, a browser or another service.
   * The link is a bearer URL: anyone who holds it can download the file until it expires, so hand
   * it only to the party that should have the file. Check `limits().methods` for `"url"` first;
   * a host that cannot serve links fails with `BlobUnavailable`.
   */
  readonly url: (handle: BlobReference, options?: BlobLinkOptions) => Promise<BlobLink>;
  /**
   * Delete a file this app created. Only the creating app may delete it. Files are shared by
   * content within an organization, so the deletion removes the handle for every app in it.
   */
  readonly delete: (handle: BlobReference) => Promise<void>;
}

/** The trusted, invocation-owned implementation behind `ctx.blobs`. */
export interface HostBlobs {
  readonly limits: Effect.Effect<BlobLimits, BlobError>;
  readonly fromUrl: (url: string, init: BlobFetchInit) => Effect.Effect<BlobHandle, BlobError>;
  readonly create: (
    bytes: Uint8Array,
    options: { readonly contentType?: string },
  ) => Effect.Effect<BlobHandle, BlobError>;
  readonly stat: (id: string) => Effect.Effect<BlobHandle, BlobError>;
  readonly url: (id: string, options: BlobLinkOptions) => Effect.Effect<BlobLink, BlobError>;
  readonly read: (
    handle: BlobHandle,
    range: { readonly offset: number; readonly length: number },
  ) => Effect.Effect<Uint8Array, BlobError>;
  readonly delete: (id: string) => Effect.Effect<void, BlobError>;
}

/** The bundle's request to the host's transfer callback. Bytes are base64. */
export const BlobCommand = Schema.Union([
  Schema.Struct({ op: Schema.Literal("limits") }),
  Schema.Struct({
    op: Schema.Literal("fromUrl"),
    url: Schema.String,
    method: Schema.optionalKey(Schema.String),
    headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    body: Schema.optionalKey(Schema.String),
    contentType: Schema.optionalKey(Schema.String),
    expectedSize: Schema.optionalKey(Schema.Int),
    expectedSha256: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    op: Schema.Literal("create"),
    bytes: Schema.String,
    contentType: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ op: Schema.Literal("stat"), id: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("url"),
    id: Schema.String,
    expiresInSeconds: Schema.optionalKey(Schema.Int),
    filename: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    op: Schema.Literal("read"),
    handle: BlobHandle,
    offset: Schema.Int,
    length: Schema.Int,
  }),
  Schema.Struct({ op: Schema.Literal("delete"), id: Schema.String }),
]);
export type BlobCommand = typeof BlobCommand.Type;

/** The host's answer: the operation's value, or one of its typed failures. */
export const BlobReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }),
  Schema.Struct({ ok: Schema.Literal(false), error: BlobError }),
]);
export type BlobReply = typeof BlobReply.Type;
