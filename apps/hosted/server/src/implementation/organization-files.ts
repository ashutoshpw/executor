/**
 * The Files page's list and administrative delete, and the visibility rule the file transfer
 * routes share with it. Owners and admins reach every complete, unexpired file of the
 * organization. A member reaches the files that apps they can use created; a file with no creator
 * app (an upload over HTTP or the CLI) and a file of an app they cannot use are hidden from them.
 */
import { BlobUnavailable } from "apps/contracts";
import { FileTransferHost, type FileTransfer } from "@executor-js/sdk/blobs";
import { StorageError, type AppId, type OwnerId } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Base64Url } from "effect/encoding";
import { CurrentUserId } from "../contracts/auth.ts";
import { CurrentAuthorization } from "../contracts/authorization.ts";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import type { GroupDatabase } from "../contracts/groups.ts";
import type { FileCreators } from "@executor-js/app-management/files";
import {
  FileNotFound,
  FilesCursorInvalid,
  FilesUnavailable,
  defaultFilesPageSize,
  type FileEntry,
} from "../contracts/files.ts";
import {
  CurrentOrganization,
  OrganizationForbidden,
  OrganizationId,
} from "../contracts/organization.ts";
import { requireOrganizationAdmin } from "./access.ts";
import { applicationAccesses, resourceAuthority } from "./resource-policy.ts";

/**
 * The apps whose files a user may reach in an organization, or `"any"` for an owner or admin. A
 * member's apps are those they can use now, as the app lists show: membership, an app's audience,
 * creator and group grants are read for this call, never taken from a token.
 */
export const visibleFileCreators = (input: {
  readonly organization: OrganizationId;
  readonly owner: OwnerId;
  readonly user: string | undefined;
}) =>
  Effect.gen(function* () {
    const actor = yield* resourceAuthority(input.organization, input.user);
    if (actor.role !== "member") return "any" as const;
    const executor = yield* Effect.flatten(HostedExecutor);
    const apps = yield* executor.apps.list({ owner: input.owner });
    const policies = yield* applicationAccesses(
      apps.map((app) => app.id),
      actor,
    );
    return policies.filter((policy) => policy.canUse).map((policy) => policy.app);
  });

/**
 * {@link visibleFileCreators} for a file transfer caller, for `fileTransferHandlers`. A caller the
 * host cannot resolve, or a failed read, reaches no file.
 */
export const fileCreatorsOf: FileCreators<GroupDatabase | HostedExecutor> = (identity) =>
  Schema.decodeUnknownEffect(OrganizationId)(identity.scope).pipe(
    Effect.flatMap((organization) =>
      visibleFileCreators({ organization, owner: identity.owner, user: identity.actor }),
    ),
    Effect.mapError(() => new BlobUnavailable()),
  );

/** The decoded form of a page cursor. */
const Cursor = Schema.Struct({ t: Schema.String, i: Schema.String });
const exactTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:[+-]\d{2}(?::\d{2})?)?$/u;

/** Whether a matching timestamp is a real date and offset, so Postgres will accept the cast. */
const realTime = (text: string) => {
  const [date = "", rest = ""] = text.split(" ");
  const [year = 0, month = 0, day = 0] = date.split("-").map(Number);
  const when = new Date(Date.UTC(year, month - 1, day));
  if (
    when.getUTCFullYear() !== year ||
    when.getUTCMonth() !== month - 1 ||
    when.getUTCDate() !== day
  )
    return false;
  const [hour = 0, minute = 0, second = 0] = rest.slice(0, 8).split(":").map(Number);
  if (hour > 23 || minute > 59 || second > 59) return false;
  const zone = /[+-](\d{2})(?::(\d{2}))?$/u.exec(rest.slice(8));
  if (zone === null) return true;
  return Number(zone[1]) <= 15 && Number(zone[2] ?? 0) <= 59;
};

const encodeCursor = (row: {
  readonly createdAtExact: string;
  readonly handle: { readonly id: string };
}) => Base64Url.encode(JSON.stringify({ t: row.createdAtExact, i: row.handle.id }));

const decodeCursor = (value: string) =>
  Effect.fromResult(Base64Url.decodeString(value)).pipe(
    Effect.flatMap((text) => Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor))(text)),
    Effect.filterOrFail(
      (cursor) => exactTime.test(cursor.t) && realTime(cursor.t),
      () => new FilesCursorInvalid(),
    ),
    Effect.mapError(() => new FilesCursorInvalid()),
    Effect.map((cursor) => ({ createdAtExact: cursor.t, id: cursor.i })),
  );

/** A credential limited to some apps' tools reaches no file: files belong to the organization. */
const requireUnlimitedCredential = Effect.gen(function* () {
  const policy = yield* CurrentAuthorization;
  if (policy.tools.kind !== "all") return yield* new OrganizationForbidden();
});

const transferOf = Effect.gen(function* () {
  const executor = yield* Effect.flatten(HostedExecutor);
  const transfer: FileTransfer | undefined = executor[FileTransferHost];
  if (transfer === undefined) return yield* new FilesUnavailable();
  return transfer;
}).pipe(Effect.catchTag("StorageError", () => Effect.fail(new FilesUnavailable())));

const unavailable = <A, R>(effect: Effect.Effect<A, BlobUnavailable | StorageError, R>) =>
  effect.pipe(Effect.mapError(() => new FilesUnavailable()));

/** One file as the Files page shows it; `names` maps an app to its current name. */
const entryOf = (
  row: {
    readonly handle: {
      readonly id: string;
      readonly contentType: string;
      readonly size: number;
      readonly sha256: string;
      readonly expiresAt: string;
    };
    readonly creator: string | undefined;
    readonly createdAt: string;
  },
  names: ReadonlyMap<AppId, string>,
): FileEntry => ({
  id: row.handle.id,
  contentType: row.handle.contentType,
  size: row.handle.size,
  sha256: row.handle.sha256,
  createdAt: row.createdAt,
  expiresAt: row.handle.expiresAt,
  app:
    row.creator === undefined
      ? null
      : { id: row.creator as AppId, name: names.get(row.creator as AppId) ?? null },
});

export const hostedOrganizationFilesHandlers = HttpApiBuilder.group(
  HostedApi,
  "organizationFiles",
  (handlers) =>
    handlers
      .handle("list", ({ query }) =>
        Effect.gen(function* () {
          yield* requireUnlimitedCredential;
          const access = yield* CurrentOrganization;
          const transfer = yield* transferOf;
          const executor = yield* Effect.flatten(HostedExecutor);
          const creators = yield* visibleFileCreators({
            organization: access.organization,
            owner: access.owner,
            user: yield* CurrentUserId,
          });
          const allApps = yield* executor.apps.list({ owner: access.owner });
          const names = new Map(allApps.map((app) => [app.id, app.name]));
          const choices = allApps
            .filter((app) => creators === "any" || creators.includes(app.id))
            .map((app) => ({ id: app.id, name: app.name }));
          // A filter on an app the caller cannot use matches nothing, whether or not it exists.
          const filtered =
            query.app !== undefined && creators !== "any" && !creators.includes(query.app);
          const limit = query.limit ?? defaultFilesPageSize;
          const after = query.after === undefined ? undefined : yield* decodeCursor(query.after);
          const rows = filtered
            ? []
            : yield* unavailable(
                transfer.userContent.handles.list({
                  owner: access.owner,
                  creators,
                  app: query.app,
                  limit: limit + 1,
                  after,
                }),
              );
          const page = rows.slice(0, limit);
          const last = page[page.length - 1];
          return {
            files: page.map((row) => entryOf(row, names)),
            next: rows.length > limit && last !== undefined ? encodeCursor(last) : null,
            apps: choices,
            canDelete: access.role !== "member",
          };
        }),
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          yield* requireUnlimitedCredential;
          const access = yield* CurrentOrganization;
          const { userContent } = yield* transferOf;
          const executor = yield* Effect.flatten(HostedExecutor);
          const creators = yield* visibleFileCreators({
            organization: access.organization,
            owner: access.owner,
            user: yield* CurrentUserId,
          });
          // A file the caller may not see answers exactly as a missing or expired one.
          const found = yield* userContent.handles
            .stat({
              owner: access.owner,
              id: params.handle,
              visible: (creator) =>
                creators === "any" ||
                (creator !== undefined && creators.includes(creator as AppId)),
            })
            .pipe(
              Effect.catchTags({
                BlobNotFound: () => Effect.fail(new FileNotFound()),
                BlobExpired: () => Effect.fail(new FileNotFound()),
                BlobUnavailable: () => Effect.fail(new FilesUnavailable()),
              }),
            );
          const allApps = yield* executor.apps.list({ owner: access.owner });
          return entryOf(found, new Map(allApps.map((app) => [app.id, app.name])));
        }),
      )
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          yield* requireUnlimitedCredential;
          // Members cannot delete, even files of their own apps; apps delete their own files
          // through `ctx.blobs.delete`.
          const access = yield* requireOrganizationAdmin;
          const { userContent } = yield* transferOf;
          const found = yield* userContent.handles
            .stat({ owner: access.owner, id: params.handle })
            .pipe(
              Effect.catchTags({
                BlobNotFound: () => Effect.fail(new FileNotFound()),
                BlobExpired: () => Effect.fail(new FileNotFound()),
                BlobUnavailable: () => Effect.fail(new FilesUnavailable()),
              }),
            );
          const claimed = yield* userContent.handles
            .retireAny({ owner: access.owner, id: params.handle })
            .pipe(
              Effect.catchTags({
                BlobNotFound: () => Effect.fail(new FileNotFound()),
                BlobUnavailable: () => Effect.fail(new FilesUnavailable()),
              }),
            );
          yield* Effect.logInfo("A file was deleted by an organization administrator").pipe(
            Effect.annotateLogs({
              "executor.organization.id": access.organization,
              "executor.file_handle.id": claimed.id,
              "executor.file.creator_app": found.creator ?? "none",
              "executor.user.id": (yield* CurrentUserId) ?? "unknown",
            }),
          );
          // A failed removal leaves the retired row for the sweep, which retries it.
          yield* userContent.store.remove(claimed.key).pipe(
            Effect.andThen(userContent.handles.finish(claimed.id)),
            Effect.catch(() =>
              Effect.logWarning("A deleted file's object could not be removed yet"),
            ),
          );
        }),
      ),
);
