/**
 * Moving user-content files over HTTP, for every product. One authorization model reaches these
 * functions two ways: a caller the product authenticated (an organization credential or the
 * local API key) names an owner and a handle, or a short-lived link a caller like that minted
 * carries the same claims. Both end in `downloadHandle` and `uploadHandle`, so Range, validators,
 * headers, limits and cleanup are one implementation. Callers decide who may reach which owner.
 *
 * Downloads never render on the product's origin: every answer is an attachment, never sniffed,
 * under a sandbox policy, whatever content type the file was stored with.
 */
import { serveRangedFile } from "apps/ui/serving";
import { Effect, Option, Schema, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  BlobError,
  BlobNotFound,
  BlobTooLarge,
  BlobUnavailable,
  BlobUpstreamFailed,
  type BlobHandle,
} from "apps/contracts";
import type { BlobKey } from "../contracts/blobs.ts";
import {
  pendingBlobSeconds,
  type BlobBegun,
  type FileTransfer,
  type UserContentOptions,
} from "../contracts/file-handles.ts";
import { FileLinkInvalid, type FileLinkClaims } from "./file-links.ts";
import { storeTransfer } from "./stored-transfer.ts";

const defaultContentType = "application/octet-stream";

/** The upload names no length, and this host cannot store a stream of unknown length. */
export class FileLengthRequired extends Schema.TaggedError<FileLengthRequired>()(
  "FileLengthRequired",
  {},
) {}

/** The answer headers common to every file response. */
const privateFileHeaders = {
  "cache-control": "private, no-store, no-transform",
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox",
  "referrer-policy": "no-referrer",
};

/** RFC 8187 `filename*`, with the characters `encodeURIComponent` leaves that its grammar does not. */
const disposition = (filename: string) =>
  `attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )}`;

/** An error as the JSON every Executor host writes it, so clients read it with one decoder. */
const failure = (status: number, tag: string, message: string, fields: object = {}) =>
  HttpServerResponse.jsonUnsafe(
    { _tag: tag, message, ...fields },
    { status, headers: { "cache-control": "no-store" } },
  );

/** The response for a failed download or upload. */
export const fileTransferError = (error: BlobError | FileLengthRequired | FileLinkInvalid) => {
  switch (error._tag) {
    case "BlobNotFound":
      return failure(404, error._tag, "This file does not exist, or it has been removed.");
    case "BlobExpired":
      return failure(410, error._tag, "This file has expired.");
    case "BlobTooLarge":
      return failure(
        413,
        error._tag,
        `This file is larger than this host stores: at most ${error.maximum} bytes.`,
        {
          maximum: error.maximum,
          ...(error.requested === undefined ? {} : { requested: error.requested }),
        },
      );
    case "FileLengthRequired":
      return failure(
        411,
        error._tag,
        "This host needs the size of an upload before it starts: send a Content-Length header.",
      );
    case "BlobIntegrityError":
      return failure(
        400,
        error._tag,
        "The uploaded bytes do not match what the request declared.",
        {
          reason: error.reason,
        },
      );
    case "BlobRangeInvalid":
      return failure(416, error._tag, "That range cannot be read.");
    case "BlobUpstreamFailed":
      return failure(400, error._tag, "The upload could not be read.");
    case "BlobUnavailable":
      return failure(503, error._tag, "This host cannot store files right now.");
    case "FileLinkInvalid":
      return error.reason === "expired"
        ? failure(410, "FileLinkExpired", "This link has expired.")
        : failure(403, error._tag, "This link is not valid.");
  }
};

/**
 * Serve a file of `owner` for the current request: the whole file or one byte range, with
 * validators. `expectedSha256` binds the answer to the bytes a link named; a handle that now holds
 * other bytes reads as missing.
 */
export const downloadHandle = (options: {
  readonly userContent: UserContentOptions;
  readonly owner: string;
  readonly id: string;
  readonly expectedSha256?: string | undefined;
  readonly filename?: string | undefined;
}): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> => {
  const { store, handles } = options.userContent;
  return Effect.gen(function* () {
    const found = yield* handles.stat({ owner: options.owner, id: options.id });
    if (options.expectedSha256 !== undefined && options.expectedSha256 !== found.handle.sha256)
      return yield* new BlobNotFound({ id: options.id });
    const key = found.key as BlobKey;
    return yield* serveRangedFile(
      {
        size: found.handle.size,
        etag: `"sha256-${found.handle.sha256}"`,
        contentType: found.handle.contentType,
        read: (range) =>
          store.stream(key, range).pipe(
            Effect.mapError(() => new BlobUnavailable()),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new BlobNotFound({ id: options.id })),
                onSome: (object) => Effect.succeed(object.body),
              }),
            ),
          ),
      },
      {
        ...privateFileHeaders,
        "content-disposition": disposition(options.filename ?? found.handle.id),
      },
    );
  }).pipe(
    Effect.catch((error) =>
      Schema.is(BlobError)(error)
        ? Effect.succeed(fileTransferError(error))
        : Effect.logWarning("A file download failed").pipe(
            Effect.as(fileTransferError(new BlobUnavailable())),
          ),
    ),
  );
};

/** The `Content-Length` of a request: a count of bytes, or nothing when it names none. */
const declaredLength = (request: HttpServerRequest.HttpServerRequest) => {
  const header = request.headers["content-length"];
  return header !== undefined && /^\d+$/u.test(header) ? Number(header) : undefined;
};

/**
 * Store the current request's body as a new file of `owner`, streaming it into the store while it
 * hashes and counts it. A declared size above the limit is refused before the body is read; a body
 * that outgrows the limit while it streams is cut off. Nothing is left behind on failure, and
 * bytes the owner already holds become that file's handle.
 */
export const uploadHandle = (options: {
  readonly userContent: UserContentOptions;
  readonly owner: string;
  readonly appId?: string | undefined;
  readonly contentType: string;
  /** A limit lower than the host's, such as one a link carries. */
  readonly maxBytes?: number | undefined;
}): Effect.Effect<
  BlobHandle,
  BlobError | FileLengthRequired,
  HttpServerRequest.HttpServerRequest
> => {
  const { store, handles, policy, hasher } = options.userContent;
  const pendingSeconds = policy.pendingSeconds ?? pendingBlobSeconds;
  const limit = Math.min(policy.maxFileBytes, options.maxBytes ?? policy.maxFileBytes);
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const declared = declaredLength(request);
    if (declared !== undefined && declared > limit)
      return yield* new BlobTooLarge({ maximum: limit, requested: declared });
    if (declared === undefined && policy.requiresSize) return yield* new FileLengthRequired();
    const pending = yield* handles.begin({
      owner: options.owner,
      appId: options.appId,
      contentType: options.contentType,
      pendingSeconds,
    });
    const begun: BlobBegun = {
      id: pending.id,
      key: pending.key,
      maxFileBytes: policy.maxFileBytes,
      maxInlineBytes: policy.maxInlineBytes,
      requiresSize: policy.requiresSize,
      renewSeconds: Math.max(1, Math.floor(pendingSeconds / 3)),
    };
    return yield* storeTransfer({
      begun,
      store,
      hasher,
      limit,
      // A request that declares no bytes has no body to read; its stream would fail.
      source:
        declared === 0
          ? Stream.empty
          : request.stream.pipe(
              Stream.mapError((): BlobError => new BlobUpstreamFailed({ reason: "transport" })),
            ),
      declare: Effect.succeed(declared),
      ports: {
        commit: (input) =>
          Effect.flatMap(policy.ttlSeconds(options.owner), (ttlSeconds) =>
            handles.commit({
              owner: options.owner,
              ...input,
              maxFileBytes: limit,
              ttlSeconds,
            }),
          ),
        touch: (id) => handles.touch({ owner: options.owner, id, pendingSeconds }),
        abort: (id) => handles.abort({ owner: options.owner, id }),
      },
    });
  });
};

/** The content type an upload names: the product's header, else `Content-Type`, else bytes. */
export const uploadContentType = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers["x-executor-content-type"] ??
  request.headers["content-type"] ??
  defaultContentType;

/** The JSON a successful upload answers with: the handle, as apps see it. */
export const uploadedResponse = (handle: BlobHandle) =>
  HttpServerResponse.jsonUnsafe(handle, {
    status: 201,
    headers: { "cache-control": "no-store" },
  });

/**
 * Answer a request to a link's URL. The token proves this host issued it for one operation on one
 * owner; `authorize` then rechecks, as the product defines it, that the user it was issued for may
 * still reach that owner. Downloads and uploads then take the same path as authenticated ones.
 */
export const redeemFileLink = <R>(options: {
  readonly transfer: FileTransfer;
  readonly token: string;
  /** Whether the link's issuer still has access to its owner; false refuses the link. */
  readonly authorize: (claims: FileLinkClaims) => Effect.Effect<boolean, BlobUnavailable, R>;
}): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | R
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { links, userContent } = options.transfer;
    if (links === undefined) return yield* new BlobUnavailable();
    const get = request.method === "GET" || request.method === "HEAD";
    if (!get && request.method !== "PUT")
      return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, HEAD, PUT" } });
    const claims = yield* links.verify(options.token, get ? "get" : "put");
    if (!(yield* options.authorize(claims)))
      return yield* new FileLinkInvalid({ reason: "signature" });
    if (get) {
      if (claims.id === undefined) return yield* new FileLinkInvalid({ reason: "malformed" });
      return yield* downloadHandle({
        userContent,
        owner: claims.owner,
        id: claims.id,
        expectedSha256: claims.sha256,
        filename: claims.filename,
      });
    }
    return uploadedResponse(
      yield* uploadHandle({
        userContent,
        owner: claims.owner,
        contentType: claims.contentType ?? uploadContentType(request),
        maxBytes: claims.maxBytes,
      }),
    );
  }).pipe(
    Effect.catch((error) =>
      Schema.is(BlobError)(error) ||
      Schema.is(FileLengthRequired)(error) ||
      Schema.is(FileLinkInvalid)(error)
        ? Effect.succeed(fileTransferError(error))
        : Effect.logWarning("A file link failed").pipe(
            Effect.as(fileTransferError(new BlobUnavailable())),
          ),
    ),
  );

/** A route's answer to an upload by an authenticated caller. */
export const uploadResponse = (
  effect: ReturnType<typeof uploadHandle>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> =>
  effect.pipe(
    Effect.map(uploadedResponse),
    Effect.catch((error) =>
      Schema.is(BlobError)(error) || Schema.is(FileLengthRequired)(error)
        ? Effect.succeed(fileTransferError(error))
        : Effect.logWarning("A file upload failed").pipe(
            Effect.as(fileTransferError(new BlobUnavailable())),
          ),
    ),
  );

/** The file is larger than the bound of the transport asking for its bytes. */
export class FileTooLarge extends Schema.TaggedError<FileTooLarge>()("FileTooLarge", {
  id: Schema.String,
  size: Schema.Int,
  maximum: Schema.Int,
  sha256: Schema.String,
}) {}

/**
 * Read a whole file of `owner` into memory, for a transport that returns bytes inline. The bound
 * is checked on the stored size before any byte is read, and again while reading, so a store that
 * yields more than it declared never fills memory.
 */
export const readHandleBytes = (options: {
  readonly userContent: UserContentOptions;
  readonly owner: string;
  readonly id: string;
  readonly maxBytes: number;
}): Effect.Effect<
  { readonly handle: BlobHandle; readonly bytes: Uint8Array },
  BlobError | FileTooLarge
> => {
  const { store, handles } = options.userContent;
  return Effect.gen(function* () {
    const found = yield* handles.stat({ owner: options.owner, id: options.id });
    const { handle } = found;
    if (handle.size > options.maxBytes)
      return yield* new FileTooLarge({
        id: handle.id,
        size: handle.size,
        maximum: options.maxBytes,
        sha256: handle.sha256,
      });
    const object = yield* store.stream(found.key as BlobKey).pipe(
      Effect.mapError(() => new BlobUnavailable()),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new BlobNotFound({ id: handle.id })),
          onSome: Effect.succeed,
        }),
      ),
    );
    // The stat'd size is already within the bound, so one buffer holds the file; a store that
    // yields more than it declared fails below, before any write past the bound.
    const capacity = Math.min(handle.size, options.maxBytes);
    let buffer = new Uint8Array(capacity);
    let total = 0;
    yield* object.body.pipe(
      Stream.runForEach((chunk) =>
        Effect.suspend(() => {
          const next = total + chunk.byteLength;
          if (next > options.maxBytes)
            return Effect.fail(
              new FileTooLarge({
                id: handle.id,
                size: next,
                maximum: options.maxBytes,
                sha256: handle.sha256,
              }),
            );
          if (next > buffer.byteLength) {
            // The store yielded more than the handle declared, within the bound: grow once.
            const grown = new Uint8Array(
              Math.min(options.maxBytes, Math.max(next, buffer.byteLength * 2)),
            );
            grown.set(buffer.subarray(0, total));
            buffer = grown;
          }
          buffer.set(chunk, total);
          total = next;
          return Effect.void;
        }),
      ),
      Effect.mapError((error) => (error instanceof FileTooLarge ? error : new BlobUnavailable())),
    );
    const bytes = total === buffer.byteLength ? buffer : buffer.slice(0, total);
    return { handle, bytes };
  });
};

const textTypes =
  /^(?:text\/|application\/(?:json|xml|javascript)(?:;|$)|[^;]+\+(?:json|xml)(?:;|$))/iu;

/**
 * The bytes as text when the content type says they are text and they decode as strict UTF-8, or
 * undefined when they must travel as binary. A mislabeled binary file never becomes replacement
 * characters.
 */
export const decodeUtf8Text = (contentType: string, bytes: Uint8Array): string | undefined => {
  if (!textTypes.test(contentType.trim())) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};
