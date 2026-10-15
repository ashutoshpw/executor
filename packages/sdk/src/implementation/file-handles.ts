/**
 * SQL-backed file-handle metadata over the product's Postgres. The table is created by the
 * product's own migration (`hosted_file_handles`, `local_file_handles`); its name is the only
 * thing that differs between products.
 *
 *   id          the handle id, also the object's key suffix
 *   owner       the owning organization or user, as the SDK names owners
 *   state       pending (reserved, bytes streaming), complete (readable), deleting (hidden)
 *   sha256/size set once complete
 *   expires_at  the file's end of life; for a pending row, when its reservation is abandoned
 */
import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
  BlobExpired,
  BlobHandle,
  BlobNotFound,
  BlobTooLarge,
  BlobUnavailable,
  type BlobError,
} from "apps/contracts";
import { BlobKey } from "../contracts/blobs.ts";
import {
  userContentFolder,
  type FileHandleStore,
  type ListedFileHandle,
  type StoredFileHandle,
} from "../contracts/file-handles.ts";

const fallbackContentType = "application/octet-stream";
const mediaType =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+-]+|"[\x20\x21\x23-\x5b\x5d-\x7e]*"))*$/u;

/**
 * A content type that is safe to store and to send back as `Content-Type`: a parseable media type
 * in printable ASCII, at most 255 characters. Anything else, including a value with CR or LF, is
 * `application/octet-stream`, so one file's metadata can never make it unservable.
 */
export const safeContentType = (value: string | undefined | null): string =>
  value !== undefined && value !== null && value.length <= 255 && mediaType.test(value.trim())
    ? value.trim()
    : fallbackContentType;

const Row = Schema.Struct({
  id: Schema.String,
  sha256: Schema.NullOr(Schema.String),
  size: Schema.NullOr(Schema.String),
  content_type: Schema.String,
  expires_at: Schema.String,
  creator_app_id: Schema.NullOr(Schema.String),
  owner: Schema.String,
  created_at: Schema.String,
});
type Row = typeof Row.Type;

/** Every column a handle needs, with times as ISO strings and the size as text. */
const columns = (
  sql: SqlClient.SqlClient,
) => sql`id, owner, sha256, size::text as size, content_type,
  to_char(expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expires_at,
  creator_app_id,
  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at`;

const ListedRow = Schema.Struct({
  ...Row.fields,
  created_at_exact: Schema.String,
});

const keyOf = (owner: string, id: string) => BlobKey.make(`${userContentFolder(owner)}/${id}`);

const stored = (row: Row): StoredFileHandle => ({
  handle: BlobHandle.make({
    id: row.id,
    sha256: row.sha256 ?? "",
    size: Number(row.size ?? 0),
    contentType: safeContentType(row.content_type),
    expiresAt: row.expires_at,
  }),
  key: keyOf(row.owner, row.id),
  creator: row.creator_app_id ?? undefined,
  createdAt: row.created_at,
});

/** Storage failures keep their operation for diagnosis, never their driver text or parameters. */
const unavailable = (operation: string) => (cause: unknown) =>
  Effect.logWarning("File handle storage failed").pipe(
    Effect.annotateLogs({
      "executor.file_handles.operation": operation,
      "error.type": Schema.is(Schema.Struct({ _tag: Schema.String }))(cause)
        ? cause._tag
        : "unknown",
    }),
    Effect.andThen(Effect.fail(new BlobUnavailable())),
  );

/**
 * The current time as the store reads it, from the process's clock rather than the database's:
 * every lifetime is judged on one clock, which a test host can move.
 */
const now = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()));

/** File-handle metadata in `table`, created by the product's migration. */
export const makeFileHandleStore = (options: {
  readonly sql: SqlClient.SqlClient;
  readonly table: string;
}): FileHandleStore => {
  const { sql } = options;
  const table = sql(options.table);
  const rows = (operation: string, query: Effect.Effect<ReadonlyArray<unknown>, unknown>) =>
    query.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))),
      Effect.catch(unavailable(operation)),
    );
  const exec = (operation: string, query: Effect.Effect<unknown, unknown>) =>
    query.pipe(Effect.asVoid, Effect.catch(unavailable(operation)));

  /** Publish a pending row, or join the owner's identical file. One attempt, in one transaction. */
  const commitOnce = (input: Parameters<FileHandleStore["commit"]>[0]) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const at = yield* now;
        const pending = yield* sql`select id from ${table}
          where id = ${input.id} and owner = ${input.owner} and state = 'pending' for update`;
        if (pending.length === 0) return yield* new BlobNotFound({ id: input.id });
        if (input.size > input.maxFileBytes)
          return yield* new BlobTooLarge({ maximum: input.maxFileBytes, requested: input.size });
        const existing = yield* sql`select id from ${table}
          where owner = ${input.owner} and sha256 = ${input.sha256} and state = 'complete' for update`;
        const hit = existing[0];
        if (hit !== undefined && Schema.is(Schema.Struct({ id: Schema.String }))(hit)) {
          yield* sql`update ${table}
            set expires_at = greatest(expires_at, ${at}::timestamptz + (${input.ttlSeconds} * interval '1 second'))
            where id = ${hit.id}`;
          // The runner already wrote this row's object. Retire the row instead of deleting it so
          // the sweep, which owns cleanup, removes the object and then the row. A 'deleting' row
          // is never served, and never a dedupe target, which both require 'complete'.
          yield* sql`update ${table} set state = 'deleting' where id = ${input.id}`;
          const found = yield* sql`select ${columns(sql)} from ${table} where id = ${hit.id}`;
          return { row: yield* Schema.decodeUnknownEffect(Row)(found[0]), deduped: true };
        }
        yield* sql`update ${table}
          set state = 'complete', sha256 = ${input.sha256}, size = ${input.size},
            expires_at = ${at}::timestamptz + (${input.ttlSeconds} * interval '1 second')
          where id = ${input.id}`;
        const found = yield* sql`select ${columns(sql)} from ${table} where id = ${input.id}`;
        return { row: yield* Schema.decodeUnknownEffect(Row)(found[0]), deduped: false };
      }),
    );

  return {
    begin: (input) =>
      Effect.gen(function* () {
        const id = crypto.randomUUID();
        const at = yield* now;
        yield* exec(
          "begin",
          sql`insert into ${table} (id, owner, state, content_type, expires_at, creator_app_id)
            values (${id}, ${input.owner}, 'pending', ${safeContentType(input.contentType)},
              ${at}::timestamptz + (${input.pendingSeconds} * interval '1 second'), ${input.appId ?? null})`,
        );
        return { id, key: keyOf(input.owner, id) };
      }),
    touch: (input) =>
      now.pipe(
        Effect.flatMap((at) =>
          exec(
            "touch",
            sql`update ${table}
              set expires_at = ${at}::timestamptz + (${input.pendingSeconds} * interval '1 second')
              where id = ${input.id} and owner = ${input.owner} and state = 'pending'`,
          ),
        ),
      ),
    commit: (input) =>
      commitOnce(input).pipe(
        // A concurrent commit of the same bytes can win the unique index between the check and
        // the update; the retry then finds the winner and joins it.
        Effect.retry({
          times: 1,
          while: (error) => !Schema.is(BlobNotFound)(error) && !Schema.is(BlobTooLarge)(error),
        }),
        Effect.map(({ row, deduped }) => ({ handle: stored(row).handle, deduped })),
        Effect.catch((error): Effect.Effect<never, BlobError> =>
          Schema.is(BlobNotFound)(error) || Schema.is(BlobTooLarge)(error)
            ? Effect.fail(error)
            : unavailable("commit")(error),
        ),
      ),
    abort: (input) =>
      exec(
        "abort",
        sql`delete from ${table} where id = ${input.id} and owner = ${input.owner} and state = 'pending'`,
      ),
    stat: (input) =>
      Effect.gen(function* () {
        const at = yield* now;
        const found = yield* rows(
          "stat",
          sql`select ${columns(sql)} from ${table}
            where id = ${input.id} and owner = ${input.owner} and state = 'complete'`,
        );
        const row = found[0];
        if (row === undefined) return yield* new BlobNotFound({ id: input.id });
        if (input.visible !== undefined && !input.visible(row.creator_app_id ?? undefined))
          return yield* new BlobNotFound({ id: input.id });
        if (Date.parse(row.expires_at) <= Date.parse(at))
          return yield* new BlobExpired({ id: input.id });
        return stored(row);
      }),
    retire: (input) =>
      now
        .pipe(
          Effect.flatMap((at) =>
            rows(
              "retire",
              sql`update ${table} set state = 'deleting'
              where id = ${input.id} and owner = ${input.owner} and state = 'complete'
                and expires_at > ${at}::timestamptz
                and (creator_app_id is null or creator_app_id = ${input.appId ?? null})
              returning ${columns(sql)}`,
            ),
          ),
        )
        .pipe(
          Effect.flatMap((found) =>
            found[0] === undefined
              ? Effect.fail(new BlobNotFound({ id: input.id }))
              : Effect.succeed({ id: found[0].id, key: keyOf(found[0].owner, found[0].id) }),
          ),
        ),
    retireAny: (input) =>
      now
        .pipe(
          Effect.flatMap((at) =>
            rows(
              "retire-any",
              sql`update ${table} set state = 'deleting'
              where id = ${input.id} and owner = ${input.owner} and state = 'complete'
                and expires_at > ${at}::timestamptz
              returning ${columns(sql)}`,
            ),
          ),
        )
        .pipe(
          Effect.flatMap((found) =>
            found[0] === undefined
              ? Effect.fail(new BlobNotFound({ id: input.id }))
              : Effect.succeed({ id: found[0].id, key: keyOf(found[0].owner, found[0].id) }),
          ),
        ),
    list: (input) =>
      Effect.gen(function* () {
        if (input.creators !== "any" && input.creators.length === 0) return [];
        const at = yield* now;
        const creators =
          input.creators === "any" ? sql`` : sql` and ${sql.in("creator_app_id", input.creators)}`;
        const app = input.app === undefined ? sql`` : sql` and creator_app_id = ${input.app}`;
        const after =
          input.after === undefined
            ? sql``
            : sql` and (created_at, id) < (${input.after.createdAtExact}::timestamptz, ${input.after.id})`;
        const found = yield* sql`select ${columns(sql)},
            created_at::text as created_at_exact
          from ${table}
          where owner = ${input.owner} and state = 'complete'
            and expires_at > ${at}::timestamptz${creators}${app}${after}
          order by created_at desc, id desc limit ${input.limit}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ListedRow))),
          Effect.catch(unavailable("list")),
        );
        return found.map((row): ListedFileHandle => ({
          handle: stored(row).handle,
          creator: row.creator_app_id ?? undefined,
          createdAt: row.created_at,
          createdAtExact: row.created_at_exact,
        }));
      }),
    finish: (id) => exec("finish", sql`delete from ${table} where id = ${id}`),
    claimExpired: (input) =>
      now
        .pipe(
          Effect.flatMap((at) =>
            rows(
              "claim",
              sql`update ${table} set state = 'deleting'
              where id in (
                select id from ${table}
                where state = 'deleting' or expires_at <= ${at}::timestamptz
                order by expires_at limit ${input.limit} for update skip locked)
              returning ${columns(sql)}`,
            ),
          ),
        )
        .pipe(
          Effect.map((claimed) =>
            claimed.map((row) => ({ id: row.id, key: keyOf(row.owner, row.id) })),
          ),
        ),
    retireOwner: (owner) =>
      exec("retire-owner", sql`update ${table} set state = 'deleting' where owner = ${owner}`),
  };
};
