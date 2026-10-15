/**
 * Additive hosted storage for task insights: each organization's argument and response recording setting and a
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

/**
 * Recording is on by default, so a new row (and an organization with no row) records. Only the
 * column defaults and rows that opted into recording before responses existed change. Those
 * organizations got record_responses = false from step 13 only through its column default, so they
 * move to true unless an administrator has since changed that choice (the audit trail names it).
 * The running server always writes both columns explicitly, so it works before and after this.
 * The journal runs it once; it is an update of few rows, not a rebuild.
 */
export const migrateTaskInsightsDefaultOn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table hosted_organization_task_settings
    alter column record_arguments set default true`;
  yield* sql`alter table hosted_organization_task_settings
    alter column record_responses set default true`;
  yield* sql`update hosted_organization_task_settings as settings
    set record_responses = true
    where settings.record_arguments = true and settings.record_responses = false
      and not exists (
        select 1 from hosted_organization_setting_audit as audit
        where audit.organization_id = settings.organization_id
          and audit.setting = 'task_insights'
          and audit.change like '%"recordResponses"%'
      )`;
});
