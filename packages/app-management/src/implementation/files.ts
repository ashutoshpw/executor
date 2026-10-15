/**
 * Handlers for the file routes. Every operation goes through the executor's file transfer, which
 * holds the store, the handles and the link signer; the product contributes only who the caller is
 * (`AppIdentity`) and, for links, whether their issuer still has access.
 */
import { FileTransferHost, type FileTransfer } from "@executor-js/sdk/blobs";
import {
  BlobError,
  BlobExpired,
  BlobNotFound,
  BlobUnavailable,
  downloadHandle,
  fileTransferError,
  FileLengthRequired,
  uploadContentType,
  uploadHandle,
  uploadResponse,
} from "@executor-js/sdk/file-transfer";
import { Context, Effect, Layer, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApi, HttpApiBuilder, type HttpApiMiddleware } from "effect/http-api";
import { AppManagementHost } from "../http.ts";
import {
  AppIdentity,
  FileExpired,
  FileNotFound,
  FilesUnavailable,
  type fileTransferApi,
} from "../contracts/api.ts";

/** The link subject of a caller the product knows no user for, such as the local paired user. */
const subjectOf = (identity: { readonly actor?: string | undefined }) =>
  identity.actor === undefined ? "local" : `user:${identity.actor}`;

const transferOf = Effect.gen(function* () {
  const host = yield* Effect.flatten(AppManagementHost);
  const transfer = host.executor[FileTransferHost];
  if (transfer === undefined) return yield* new BlobUnavailable();
  return transfer;
}).pipe(Effect.mapError(() => new BlobUnavailable()));

/** The typed failures of the JSON endpoints. */
const linkFailure = (error: BlobError) =>
  Schema.is(BlobNotFound)(error)
    ? new FileNotFound()
    : Schema.is(BlobExpired)(error)
      ? new FileExpired()
      : new FilesUnavailable();

/** A raw route's failure, written as the JSON error every Executor host answers with. */
const rawFailure = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, BlobError | FileLengthRequired, R>,
) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.succeed(
        fileTransferError(
          Schema.is(BlobError)(error) || Schema.is(FileLengthRequired)(error)
            ? error
            : new BlobUnavailable(),
        ),
      ),
    ),
  );

/**
 * The apps whose files a caller may reach: `"any"`, or the ids of those apps. A host that supplies
 * this hides every other file, including one with no creator app, as missing: the answer does not
 * say whether the file exists. A host that supplies nothing lets the caller reach every file of
 * the owner, as the local paired user does.
 */
export type FileCreators<R> = (
  identity: Context.Service.Shape<typeof AppIdentity>,
) => Effect.Effect<"any" | ReadonlyArray<string>, BlobUnavailable, R>;

const creatorVisibility = <R>(
  creators: FileCreators<R> | undefined,
  identity: Context.Service.Shape<typeof AppIdentity>,
) =>
  (creators === undefined ? Effect.succeed("any" as const) : creators(identity)).pipe(
    Effect.map(
      (allowed) => (creator: string | undefined) =>
        allowed === "any" || (creator !== undefined && allowed.includes(creator)),
    ),
  );

export const fileTransferHandlers = <
  I extends HttpApiMiddleware.AnyId,
  S,
  Id extends string,
  R = never,
>(
  api: ReturnType<typeof fileTransferApi<I, S>>,
  apiId: Id,
  creators?: FileCreators<R>,
) =>
  HttpApiBuilder.group(HttpApi.make(apiId).addHttpApi(api), "files", (handlers) =>
    handlers
      .handleRaw("download", ({ params }) =>
        rawFailure(
          Effect.gen(function* () {
            const identity = yield* AppIdentity;
            const transfer = yield* transferOf;
            const visible = yield* creatorVisibility(creators, identity);
            return yield* downloadHandle({
              userContent: transfer.userContent,
              owner: identity.owner,
              id: params.handle,
              visible,
            });
          }),
        ),
      )
      .handleRaw("upload", () =>
        rawFailure(
          Effect.gen(function* () {
            const identity = yield* AppIdentity;
            const transfer = yield* transferOf;
            const request = yield* HttpServerRequest.HttpServerRequest;
            return yield* uploadResponse(
              uploadHandle({
                userContent: transfer.userContent,
                owner: identity.owner,
                contentType: uploadContentType(request),
              }),
            );
          }),
        ),
      )
      .handle("downloadUrl", ({ params, payload }) =>
        Effect.gen(function* () {
          const identity = yield* AppIdentity;
          const transfer: FileTransfer = yield* transferOf;
          if (transfer.links === undefined) return yield* new BlobUnavailable();
          const found = yield* transfer.userContent.handles.stat({
            owner: identity.owner,
            id: params.handle,
            visible: yield* creatorVisibility(creators, identity),
          });
          return yield* transfer.links.signGet({
            owner: identity.owner,
            id: found.handle.id,
            sha256: found.handle.sha256,
            subject: subjectOf(identity),
            expiresInSeconds: payload.expiresInSeconds,
            filename: payload.filename,
          });
        }).pipe(Effect.mapError(linkFailure)),
      )
      .handle("uploadUrl", ({ payload }) =>
        Effect.gen(function* () {
          const identity = yield* AppIdentity;
          const transfer: FileTransfer = yield* transferOf;
          if (transfer.links === undefined) return yield* new BlobUnavailable();
          return yield* transfer.links.signPut({
            owner: identity.owner,
            subject: subjectOf(identity),
            expiresInSeconds: payload.expiresInSeconds,
            contentType: payload.contentType,
            maxBytes:
              payload.maxBytes === undefined
                ? undefined
                : Math.min(payload.maxBytes, transfer.userContent.policy.maxFileBytes),
          });
        }).pipe(Effect.mapError(linkFailure)),
      ),
  );

/** Mount the file routes under a product's authorized API prefix. */
export const fileTransferRoutes = <I extends HttpApiMiddleware.AnyId, S>(
  api: ReturnType<typeof fileTransferApi<I, S>>,
) => HttpApiBuilder.layer(api).pipe(Layer.provide(fileTransferHandlers(api, api.identifier)));
