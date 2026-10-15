/**
 * The `files` half of an MCP backend, over a host's file transfer. Products decide the owner (an
 * organization, or the one local user) and who the caller is for links; this module maps the
 * stored handles, the bounded read and the signed link onto the backend's typed answers.
 */
import { BlobError } from "apps/contracts";
import {
  defaultFileLinkSeconds,
  decodeUtf8Text,
  readHandleBytes,
} from "@executor-js/sdk/file-transfer";
import type { FileTransfer } from "@executor-js/sdk/blobs";
import { Effect, Schema } from "effect";
import {
  FileNotFound,
  FileTooLargeForResource,
  FilesUnavailable,
  type McpBackend,
} from "../contracts/backend.ts";

const isBlobError = Schema.is(BlobError);

/** Everything but "missing or expired" means the store could not answer. */
const unknownFile =
  (id: string) =>
  (error: unknown): FileNotFound | FilesUnavailable =>
    isBlobError(error) && (error._tag === "BlobNotFound" || error._tag === "BlobExpired")
      ? new FileNotFound({ id })
      : new FilesUnavailable();

/**
 * `transfer` is read per operation, since a host may build its executor lazily. `owner` is the SDK
 * owner of the caller's files; `organization` the URI segment links name. `subject` is the link
 * subject (`user:<id>`), or undefined when the caller has none and so can be given no link.
 */
export const fileBackend = <E extends Error>(options: {
  readonly transfer: Effect.Effect<FileTransfer | undefined, E>;
  readonly owner: string;
  readonly organization: string;
  readonly subject: string | undefined;
}): McpBackend<E>["files"] => {
  const available = Effect.flatMap(options.transfer, (transfer) =>
    transfer === undefined ? Effect.fail(new FilesUnavailable()) : Effect.succeed(transfer),
  );
  return {
    organization: Effect.succeed(options.organization),
    stat: ({ id }) =>
      Effect.gen(function* () {
        const { userContent } = yield* available;
        const found = yield* userContent.handles
          .stat({ owner: options.owner, id })
          .pipe(Effect.mapError(unknownFile(id)));
        return { handle: found.handle };
      }),
    read: ({ organization, id }) =>
      Effect.gen(function* () {
        // The URI's organization is advisory: another one's file is not found, never forbidden.
        if (organization !== options.organization) return yield* new FileNotFound({ id });
        const transfer = yield* available;
        const { userContent, links } = transfer;
        const read = yield* readHandleBytes({
          userContent,
          owner: options.owner,
          id,
          maxBytes: userContent.policy.maxResourceReadBytes,
        }).pipe(
          Effect.catchTag("FileTooLarge", (tooLarge) =>
            Effect.gen(function* () {
              const link =
                links === undefined || options.subject === undefined
                  ? undefined
                  : yield* links.signGet({
                      owner: options.owner,
                      id: tooLarge.id,
                      sha256: tooLarge.sha256,
                      subject: options.subject,
                      expiresInSeconds: defaultFileLinkSeconds,
                    });
              return yield* new FileTooLargeForResource({
                id: tooLarge.id,
                size: tooLarge.size,
                maximum: tooLarge.maximum,
                sha256: tooLarge.sha256,
                ...(link === undefined ? {} : { url: link.url, expiresAt: link.expiresAt }),
              });
            }),
          ),
          Effect.mapError((error) =>
            error instanceof FileTooLargeForResource ? error : unknownFile(id)(error),
          ),
        );
        const text = decodeUtf8Text(read.handle.contentType, read.bytes);
        return {
          handle: read.handle,
          contents:
            text === undefined
              ? ({ _tag: "blob", bytes: read.bytes } as const)
              : ({ _tag: "text", text } as const),
        };
      }),
  };
};
