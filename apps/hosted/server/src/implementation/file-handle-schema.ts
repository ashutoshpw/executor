/**
 * Additive hosted storage for user-content file handles and each organization's lifetime setting.
 * Both tables are new and empty, so the running server never reads them and nothing is rewritten.
 * The handle rows carry no foreign keys: owners are opaque SDK owners, and an organization's files
 * are retired by the sweep rather than cascaded away under a lock.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Run under the hosted migration lock after Better Auth has created its organization table. */
export const migrateFileHandles = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table if not exists hosted_file_handles (
    id text primary key,
    owner text not null,
    state text not null check (state in ('pending', 'complete', 'deleting')),
    sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
    size bigint check (size is null or size >= 0),
    content_type text not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    creator_app_id text,
    check (state = 'pending' or state = 'deleting' or (sha256 is not null and size is not null))
  )`;
  yield* sql`create unique index if not exists hosted_file_handles_owner_sha256
    on hosted_file_handles (owner, sha256) where state = 'complete'`;
  yield* sql`create index if not exists hosted_file_handles_expiry on hosted_file_handles (expires_at)`;
  yield* sql`create table if not exists hosted_organization_blob_settings (
    organization_id text primary key references organization(id) on delete cascade,
    ttl_seconds bigint not null check (ttl_seconds between 3600 and 31536000),
    updated_at timestamptz not null default now()
  )`;
});

/**
 * Additive: the Files page lists an organization's complete files newest first. The index is
 * partial, so it holds only readable files, and only the Files page reads it. It builds inside the
 * migration transaction, whose lock and statement timeouts fail the deploy instead of waiting
 * behind live writes; the table is at most one release old, so the build is short.
 */
export const migrateFileHandleListing = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create index if not exists hosted_file_handles_owner_created
    on hosted_file_handles (owner, created_at desc, id desc) where state = 'complete'`;
});
