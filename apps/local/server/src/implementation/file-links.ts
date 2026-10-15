/**
 * Redeeming a file link on the local server. The one local user minted it, so the token's
 * signature and the file's own state are the whole check: there is no membership to recheck.
 */
import { BlobUnavailable } from "apps/contracts";
import type { Executor } from "@executor-js/sdk/core";
import { FileTransferHost } from "@executor-js/sdk/blobs";
import { fileTransferError, redeemFileLink } from "@executor-js/sdk/file-transfer";
import { Effect } from "effect";
import { HttpRouter } from "effect/http";

/**
 * `/api/file-links/<token>`: GET and HEAD download, PUT uploads, with no credential but the token.
 * It is a wildcard route because a token is longer than a router's parameter may be.
 */
export const localFileLink = (executor: Executor) =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const transfer = executor[FileTransferHost];
    if (transfer === undefined) return fileTransferError(new BlobUnavailable());
    return yield* redeemFileLink({
      transfer,
      token: params["*"] ?? "",
      authorize: () => Effect.succeed(true),
    });
  });
