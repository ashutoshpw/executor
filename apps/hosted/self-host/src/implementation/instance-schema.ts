/** Instance-level state: who completed setup and which organization setup created. */
import type { BetterAuthPlugin } from "better-auth";
import { migrateProductSteps } from "@executor-js/hosted-server/migrations";
import { SqlClient } from "effect/sql";
import { Effect } from "effect";

/**
 * A separate table, not columns on Better Auth's: its migrator cannot repair required columns
 * on its own tables. The singleton `key` allows one row. Owner and primary organization are
 * restricted from deletion, so the instance never loses either.
 */
export const selfHostInstanceSchema = {
  id: "executor-self-host-instance",
  schema: {
    selfHostInstance: {
      fields: {
        key: { type: "string", required: true, unique: true },
        ownerUserId: {
          type: "string",
          required: true,
          references: { model: "user", field: "id", onDelete: "restrict" },
        },
        primaryOrganizationId: {
          type: "string",
          required: true,
          references: { model: "organization", field: "id", onDelete: "restrict" },
        },
        createdAt: { type: "date", required: true },
      },
    },
  },
} satisfies BetterAuthPlugin;

/**
 * Existing instances predate the record: the owner is the owner of the oldest organization, the
 * one setup created. Prefer an owner, then an admin, then any member if roles have since changed,
 * so the instance is never left without one. A fresh database has no organization; setup writes
 * the row instead. Runs after Better Auth created the table and is recorded once.
 */
const backfillInstance = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`insert into "selfHostInstance" (id, key, "ownerUserId", "primaryOrganizationId", "createdAt")
    select gen_random_uuid()::text, 'instance', member."userId", oldest.id, now()
    from (select id from organization order by "createdAt" asc, id asc limit 1) as oldest
    join member on member."organizationId" = oldest.id
    order by case
      when 'owner' = any(string_to_array(member.role, ',')) then 0
      when 'admin' = any(string_to_array(member.role, ',')) then 1
      else 2
    end, member."createdAt" asc, member.id asc
    limit 1
    on conflict (key) do nothing`;
});

export const migrateSelfHostInstance = migrateProductSteps("private_self_host_migrations", {
  "1_instance_owner": backfillInstance,
});
