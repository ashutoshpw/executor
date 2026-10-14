/** The organization's file lifetime: stored per organization, defaulting to seven days. */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import {
  BlobTtlOutOfRange,
  defaultBlobTtlSeconds,
  maxBlobTtlSeconds,
  minBlobTtlSeconds,
  type BlobSettings,
} from "../contracts/blob-settings.ts";
import { GroupDatabase, GroupsUnavailable } from "../contracts/groups.ts";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";

const owners = "organization:";
const TtlRow = Schema.Struct({ ttl_seconds: Schema.String });

/**
 * The lifetime for an SDK owner. Only organization owners have a setting; any other owner, and an
 * organization that never chose one, gets the default. A failed read keeps the default rather than
 * failing a transfer: a file that lives seven days is safe, one that lives for no time is not.
 */
export const organizationBlobTtl = (sql: SqlClient.SqlClient) => (owner: string) =>
  owner.startsWith(owners)
    ? sql`select ttl_seconds::text as ttl_seconds from hosted_organization_blob_settings
        where organization_id = ${owner.slice(owners.length)}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TtlRow))),
        Effect.map((rows) =>
          rows[0] === undefined ? defaultBlobTtlSeconds : Number(rows[0].ttl_seconds),
        ),
        Effect.catch(() =>
          Effect.logWarning("The organization's file lifetime could not be read").pipe(
            Effect.as(defaultBlobTtlSeconds),
          ),
        ),
      )
    : Effect.succeed(defaultBlobTtlSeconds);

const view = (ttlSeconds: number, canEdit: boolean): BlobSettings => ({
  ttlSeconds,
  defaultTtlSeconds: defaultBlobTtlSeconds,
  minTtlSeconds: minBlobTtlSeconds,
  maxTtlSeconds: maxBlobTtlSeconds,
  canEdit,
});

const database = Effect.flatten(GroupDatabase);

/** Typed handlers; the database is acquired after authentication and the role check. */
export const hostedBlobSettingsHandlers = HttpApiBuilder.group(
  HostedApi,
  "blobSettings",
  (handlers) =>
    handlers
      .handle("get", () =>
        Effect.gen(function* () {
          const access = yield* CurrentOrganization;
          const sql = yield* database;
          const ttl = yield* organizationBlobTtl(sql)(access.owner);
          return view(ttl, access.role !== "member");
        }),
      )
      .handle("update", ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentOrganization;
          if (access.role === "member") return yield* new OrganizationForbidden();
          if (payload.ttlSeconds < minBlobTtlSeconds || payload.ttlSeconds > maxBlobTtlSeconds)
            return yield* new BlobTtlOutOfRange();
          const sql = yield* database;
          yield* sql`insert into hosted_organization_blob_settings (organization_id, ttl_seconds)
            values (${access.organization}, ${payload.ttlSeconds})
            on conflict (organization_id) do update
              set ttl_seconds = excluded.ttl_seconds, updated_at = now()`.pipe(
            Effect.mapError(() => new GroupsUnavailable()),
          );
          return view(payload.ttlSeconds, true);
        }),
      ),
);
