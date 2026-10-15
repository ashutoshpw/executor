/** Self-host publishers are organizations; a scope is `<slug>.<publishing domain>`, read as it is now. */
import type { Publishers } from "@executor-js/app-registry";
import {
  OrganizationId,
  organizationOwner,
  publishingScope,
  publishingSlug,
} from "@executor-js/hosted-server/organization";
import { OwnerId, RegistryError } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

const Organization = Schema.Struct({ id: OrganizationId, slug: Schema.String });
const ownerPrefix = "organization:";

/**
 * Capture the instance's client. Every call reads the slug as it is now, never a cached one.
 * Self-host cannot remove an organization, so none is hidden.
 */
export const selfHostPublishers = (domain: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = <A, E>(work: Effect.Effect<A, E>) =>
      work.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Organization))),
        Effect.mapError(() => new RegistryError({ reason: "storage" })),
      );
    const owner = (scope: string, hold: boolean) =>
      Effect.gen(function* () {
        const slug = publishingSlug(scope, domain);
        if (slug === undefined) return null;
        const [row] = yield* read(
          hold
            ? sql`select o.id, o.slug from organization o where o.slug = ${slug} for share of o`
            : sql`select o.id, o.slug from organization o where o.slug = ${slug}`,
        );
        return row === undefined ? null : organizationOwner(row.id);
      });
    return {
      owner: (scope) => owner(scope, false),
      hold: (scope) => owner(scope, true),
      scopes: (owners) =>
        Effect.gen(function* () {
          const ids = owners.flatMap((owner) =>
            owner.startsWith(ownerPrefix) ? [owner.slice(ownerPrefix.length)] : [],
          );
          if (ids.length === 0) return new Map<OwnerId, string>();
          const rows = yield* read(
            sql`select o.id, o.slug from organization o where o.id in ${sql.in(ids)}`,
          );
          return new Map(
            rows.map((row) => [organizationOwner(row.id), publishingScope(row.slug, domain)]),
          );
        }),
    } satisfies Publishers;
  });
