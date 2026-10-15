/**
 * Additive hosted storage for task insights: each organization's argument recording setting and a
 * trail of changes to organization settings. Both tables are new and empty, so the running server
 * never reads them and nothing is rewritten. Argument values themselves live with the usage records.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Run under the hosted migration lock after Better Auth has created its organization table. */
export const migrateTaskInsights = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists hosted_organization_task_settings (
    organization_id text primary key references organization(id) on delete cascade,
    record_arguments boolean not null default false,
    retention_days integer not null default 30 check (retention_days in (7, 30, 90)),
    extra_masked_keys text not null default '[]',
    updated_at timestamptz not null default now()
  )`;
  // Rows outlive the organization's removal and the member's account on purpose: who changed a
  // setting is the point of the trail, so there are no foreign keys.
  yield* sql`create table if not exists hosted_organization_setting_audit (
    id text primary key,
    organization_id text not null,
    actor_user_id text not null,
    setting text not null,
    change text not null,
    created_at timestamptz not null default now()
  )`;
  yield* sql`create index if not exists hosted_organization_setting_audit_organization
    on hosted_organization_setting_audit (organization_id, created_at desc)`;
});

/** Additive: the response recording choice, off for every existing row. */
export const migrateTaskInsightsResponses = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table hosted_organization_task_settings
    add column if not exists record_responses boolean not null default false`;
});
