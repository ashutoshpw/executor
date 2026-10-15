/**
 * Files an organization's apps keep by handle, moved over HTTP. A handle is only a reference; these
 * routes move the bytes it names, for a caller the product has authenticated. A link carries the
 * same authority for one operation, for a while, to a party that holds no credential: it is minted
 * here and redeemed at `/api/file-links/<token>`, which the product serves outside this API.
 */
import { Context, Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
  type HttpApiMiddleware,
} from "effect/http-api";
import { ApiError } from "@executor-js/utils/api-error";

/** The file does not exist for this organization, or it has been removed. */
export const FileNotFound = ApiError.define({
  tag: "FileNotFound",
  status: 404,
  message: "This file does not exist, or it has been removed.",
});
/** The file's lifetime ended. */
export const FileExpired = ApiError.define({
  tag: "FileExpired",
  status: 410,
  message: "This file has expired.",
});
/** This host stores no files, or cannot issue links, or its store failed. */
export const FilesUnavailable = ApiError.define({
  tag: "FilesUnavailable",
  status: 503,
  message: "This host cannot store or link files right now.",
});

/** How a download link behaves. */
export const FileDownloadLinkRequest = Schema.Struct({
  expiresInSeconds: Schema.optional(Schema.Int),
  filename: Schema.optional(Schema.String),
});
/** How an upload link behaves. */
export const FileUploadLinkRequest = Schema.Struct({
  expiresInSeconds: Schema.optional(Schema.Int),
  contentType: Schema.optional(Schema.String),
  maxBytes: Schema.optional(Schema.Int),
});
/** A link and when it stops working. */
export const FileLink = Schema.Struct({
  url: Schema.String,
  /** ISO-8601 time after which the link stops working. */
  expiresAt: Schema.String,
});
export type FileLink = typeof FileLink.Type;

/** The `Content-Type` an upload names, when it should not be the request's own. */
export const fileContentTypeHeader = "x-executor-content-type";

/**
 * File routes under a product's authorized API prefix. `download` and `upload` stream raw bytes:
 * `download` answers `Range`, `If-None-Match` and `If-Range` as a static file server does, and
 * `upload` needs a `Content-Length` on hosts that cannot store a stream of unknown length.
 */
const fileTransferGroup = <I extends HttpApiMiddleware.AnyId, S, T extends Schema.Struct.Fields>(
  prefix: "/api" | "/api/organizations/:organization",
  tenantFields: T,
  access: Context.Key<I, S>,
) => {
  const tenant = Schema.Struct(tenantFields);
  const file = Schema.Struct({ ...tenantFields, handle: Schema.NonEmptyString });
  const errors = [FileNotFound, FileExpired, FilesUnavailable];
  return HttpApi.make("file-transfer").add(
    HttpApiGroup.make("files")
      .add(
        HttpApiEndpoint.get("download", "/files/:handle", { params: file }).annotate(
          OpenApi.Description,
          "Download a file's bytes. Supports single byte ranges, so an interrupted download resumes. The answer's ETag is quoted sha256-<hex>, naming the exact bytes.",
        ),
        HttpApiEndpoint.put("upload", "/files", { params: tenant }).annotate(
          OpenApi.Description,
          `Store the request body as a new file. Name its type in ${fileContentTypeHeader} or Content-Type. Answers 201 with the file's handle; identical bytes already stored answer with that file's handle. Answers 413 above the host's limit and 411 when this host needs a Content-Length.`,
        ),
        HttpApiEndpoint.post("downloadUrl", "/files/:handle/download-url", {
          params: file,
          payload: FileDownloadLinkRequest,
          success: FileLink,
          error: errors,
        }).annotate(
          OpenApi.Description,
          "Mint a short-lived URL that downloads this file with an ordinary GET and no other credential. The URL is a bearer secret.",
        ),
        HttpApiEndpoint.post("uploadUrl", "/files/upload-url", {
          params: tenant,
          payload: FileUploadLinkRequest,
          success: FileLink,
          error: errors,
        }).annotate(
          OpenApi.Description,
          "Mint a short-lived URL that accepts one or more uploads with an ordinary PUT and no other credential. The URL is a bearer secret.",
        ),
      )
      .prefix(prefix)
      .middleware(access),
  );
};

/** The file routes of one product, typed by the path parameters its prefix names. */
export type FileTransferApi<
  I extends HttpApiMiddleware.AnyId,
  S,
  T extends Schema.Struct.Fields,
> = ReturnType<typeof fileTransferGroup<I, S, T>>;

const organizationFields = { organization: Schema.NonEmptyString };

/** Either product's file routes, for handlers that read only the file's handle. */
export type AnyFileTransferApi<I extends HttpApiMiddleware.AnyId, S> =
  | FileTransferApi<I, S, {}>
  | FileTransferApi<I, S, typeof organizationFields>;

/**
 * Overloaded by prefix so a client of the organization prefix must name the organization: one
 * signature over both prefixes would type the path parameters without it and let a call omit it.
 */
export function fileTransferApi<I extends HttpApiMiddleware.AnyId, S>(
  prefix: "/api",
  access: Context.Key<I, S>,
): FileTransferApi<I, S, {}>;
export function fileTransferApi<I extends HttpApiMiddleware.AnyId, S>(
  prefix: "/api/organizations/:organization",
  access: Context.Key<I, S>,
): FileTransferApi<I, S, typeof organizationFields>;
export function fileTransferApi<I extends HttpApiMiddleware.AnyId, S>(
  prefix: "/api" | "/api/organizations/:organization",
  access: Context.Key<I, S>,
) {
  return prefix === "/api"
    ? fileTransferGroup(prefix, {}, access)
    : fileTransferGroup(prefix, organizationFields, access);
}
