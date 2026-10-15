/**
 * Redeeming a file link. A link is a bearer URL its issuer minted for one operation on their
 * organization's files; the signature proves this host issued it, and this route rechecks what a
 * signature cannot: that the file still exists, and that the user it was issued for is still a
 * member, so removing a member stops their links at once. A link an app minted for no user
 * (`app:<id>`, from a scheduled run) is bound to the app's organization by its owner and has no
 * member to recheck.
 */
import { BlobUnavailable } from "apps/contracts";
import { FileTransferHost } from "@executor-js/sdk/blobs";
import { fileTransferError, redeemFileLink } from "@executor-js/sdk/file-transfer";
import { Effect, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { HostedExecutor } from "../contracts/executor.ts";
import { OrganizationId } from "../contracts/organization.ts";
import { resourceAuthority } from "./resource-policy.ts";

const organizationOwner = "organization:";
const userSubject = "user:";
const appSubject = "app:";

/** Whether the user a link was issued for is still a member of the organization that owns it. */
const stillAuthorized = (claims: { readonly owner: string; readonly subject: string }) => {
  if (claims.subject.startsWith(appSubject)) return Effect.succeed(true);
  if (!claims.subject.startsWith(userSubject) || !claims.owner.startsWith(organizationOwner))
    return Effect.succeed(false);
  return Schema.decodeUnknownEffect(OrganizationId)(
    claims.owner.slice(organizationOwner.length),
  ).pipe(
    Effect.flatMap((organization) =>
      resourceAuthority(organization, claims.subject.slice(userSubject.length)),
    ),
    Effect.as(true),
    Effect.catchTag("OrganizationForbidden", () => Effect.succeed(false)),
    Effect.catch(() => Effect.fail(new BlobUnavailable())),
  );
};

/**
 * `/api/file-links/<token>`: GET and HEAD download, PUT uploads, with no credential but the token.
 * It is a wildcard route because a token is longer than a router's parameter may be.
 */
export const hostedFileLink = Effect.gen(function* () {
  const params = yield* HttpRouter.params;
  const executor = yield* Effect.flatten(HostedExecutor);
  const transfer = executor[FileTransferHost];
  if (transfer === undefined) return fileTransferError(new BlobUnavailable());
  return yield* redeemFileLink({
    transfer,
    token: params["*"] ?? "",
    authorize: stillAuthorized,
  });
}).pipe(
  Effect.catch(() =>
    Effect.logWarning("A file link could not be served").pipe(
      Effect.as(fileTransferError(new BlobUnavailable())),
    ),
  ),
);
