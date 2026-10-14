/** Self-host usage records: one DuckDB file beside the other local state, written in batches. */
import type { DuckDBConnection, DuckDBValue } from "@w3devx/duckdb-node-api";
import {
  emptyUsage,
  UsageStore,
  type UsageAggregates,
  type UsageQuery,
  type UsageRange,
  type UsageToolCall,
} from "@executor-js/hosted-server";
import { AppId } from "@executor-js/sdk/core";
import { Data, Effect, Path, Schedule, Semaphore } from "effect";
import { dataDirectory } from "../contracts/config.ts";

const flushEvery = "1 second";
const flushSize = 500;
/** Calls waiting for a flush that never succeeds are dropped, oldest first, rather than growing without bound. */
const bufferLimit = 20_000;
const retentionDays = 90;
const dayMillis = 24 * 60 * 60 * 1000;
const rangeMillis: Record<UsageRange, number> = {
  "24h": dayMillis,
  "7d": 7 * dayMillis,
  "30d": 30 * dayMillis,
};
const schemaVersion = 1;

class UnsupportedDuckDB extends Data.TaggedError("UnsupportedDuckDB")<{
  readonly version: string;
}> {}

const count = (value: DuckDBValue | undefined) => Number(value);

/**
 * Open the usage database, or fall back to keeping nothing: usage records never stop the product
 * from starting. One process owns the file; a second instance on the same data directory runs without it.
 */
export const selfHostUsageStore = Effect.gen(function* () {
  const duckdb = yield* Effect.tryPromise(() => import("@w3devx/duckdb-node-api"));
  // The file format and SQL here target DuckDB 2; an older library could not reopen the file later.
  const library = duckdb.version();
  if (!library.startsWith("v2.")) return yield* new UnsupportedDuckDB({ version: library });
  const path = yield* Path.Path;
  const directory = path.resolve(yield* dataDirectory);
  const instance = yield* Effect.tryPromise(() =>
    duckdb.DuckDBInstance.create(path.join(directory, "usage.duckdb"), {
      threads: "2",
      memory_limit: "256MB",
    }),
  );
  // A connection runs one statement at a time: the writer flushes and prunes, the reader serves queries.
  const writer = yield* Effect.tryPromise(() => instance.connect());
  const reader = yield* Effect.tryPromise(() => instance.connect());
  const writerLock = Semaphore.makeUnsafe(1);
  const readerLock = Semaphore.makeUnsafe(1);
  const timestamp = (date: Date) => new duckdb.DuckDBTimestampValue(BigInt(date.getTime()) * 1000n);

  yield* Effect.tryPromise(async () => {
    await writer.run("create table if not exists usage_schema(version integer not null)");
    await writer.run(
      `create table if not exists usage_tool_calls(
        occurred_at timestamp not null,
        organization_id varchar not null,
        user_id varchar not null,
        agent_key varchar not null,
        agent_label varchar not null,
        source varchar not null,
        app_id varchar not null,
        tool_name varchar not null,
        outcome varchar not null,
        error_type varchar,
        duration_ms integer not null
      )`,
    );
    const rows = await writer.runAndReadAll("select version from usage_schema");
    if (rows.getRowObjects().length === 0)
      await writer.run("insert into usage_schema values (?)", [schemaVersion]);
  });

  const buffer: UsageToolCall[] = [];
  let flushFailed = false;
  const append = async (connection: DuckDBConnection, batch: readonly UsageToolCall[]) => {
    await connection.run("begin transaction");
    try {
      const appender = await connection.createAppender("usage_tool_calls");
      try {
        // Rows go in time order so DuckDB's zone maps keep the range filter cheap.
        for (const call of batch.toSorted((a, b) => a.at.getTime() - b.at.getTime())) {
          appender.appendTimestamp(timestamp(call.at));
          appender.appendVarchar(call.organizationId);
          appender.appendVarchar(call.userId);
          appender.appendVarchar(call.agentKey);
          appender.appendVarchar(call.agentLabel);
          appender.appendVarchar(call.source);
          appender.appendVarchar(call.appId);
          appender.appendVarchar(call.toolName);
          appender.appendVarchar(call.outcome);
          if (call.errorType === undefined) appender.appendNull();
          else appender.appendVarchar(call.errorType);
          appender.appendInteger(Math.min(Math.round(call.durationMs), 2_147_483_647));
          appender.endRow();
        }
        appender.flushSync();
      } finally {
        appender.closeSync();
      }
      await connection.run("commit");
    } catch (error) {
      await connection.run("rollback").catch(() => {});
      throw error;
    }
  };
  const flush = writerLock.withPermits(1)(
    Effect.suspend(() => {
      const batch = buffer.splice(0);
      if (batch.length === 0) return Effect.void;
      return Effect.tryPromise(() => append(writer, batch)).pipe(
        Effect.tap(() => Effect.sync(() => (flushFailed = false))),
        // Warn once per outage; the batch is dropped so a persistent fault cannot stall later ones.
        Effect.catch(() =>
          flushFailed
            ? Effect.void
            : Effect.sync(() => (flushFailed = true)).pipe(
                Effect.andThen(Effect.logWarning("Usage records could not be written")),
              ),
        ),
      );
    }),
  );
  const prune = writerLock.withPermits(1)(
    Effect.tryPromise(() =>
      writer.run("delete from usage_tool_calls where occurred_at < ?", [
        timestamp(new Date(Date.now() - retentionDays * dayMillis)),
      ]),
    ).pipe(Effect.catch(() => Effect.logWarning("Usage retention could not run"))),
  );

  yield* Effect.forkScoped(flush.pipe(Effect.repeat(Schedule.spaced(flushEvery))));
  yield* Effect.forkScoped(prune.pipe(Effect.repeat(Schedule.spaced("24 hours"))));
  yield* Effect.addFinalizer(() =>
    flush.pipe(
      Effect.andThen(Effect.tryPromise(() => writer.run("checkpoint"))),
      Effect.ignore,
      Effect.andThen(
        Effect.sync(() => {
          reader.closeSync();
          writer.closeSync();
          instance.closeSync();
        }),
      ),
    ),
  );

  const read = (sql: string, params: DuckDBValue[]) =>
    readerLock.withPermits(1)(
      Effect.tryPromise(async () => (await reader.runAndReadAll(sql, params)).getRowObjects()),
    );
  const query = (input: UsageQuery) =>
    Effect.gen(function* () {
      const where = `where organization_id = ? and occurred_at >= ?${input.userId === undefined ? "" : " and user_id = ?"}`;
      const params: DuckDBValue[] = [
        input.organization,
        timestamp(new Date(Date.now() - rangeMillis[input.range])),
        ...(input.userId === undefined ? [] : [input.userId]),
      ];
      const failed = `count(*) filter (where outcome = 'failure')`;
      const [totals, daily, apps, agents, tools, failures] = yield* Effect.all([
        read(
          `select count(*) as calls, ${failed} as failures,
            count(*) filter (where outcome = 'success') as successes,
            count(distinct agent_key) as agents, count(distinct app_id) as apps,
            coalesce(avg(duration_ms), 0) as avg_duration
          from usage_tool_calls ${where}`,
          params,
        ),
        read(
          `select cast(occurred_at as date)::varchar as day, count(*) as calls, ${failed} as failures
          from usage_tool_calls ${where} group by day order by day`,
          params,
        ),
        read(
          `select app_id, count(*) as calls, ${failed} as failures
          from usage_tool_calls ${where} group by app_id order by calls desc, app_id limit 10`,
          params,
        ),
        read(
          `select agent_key, arg_max(agent_label, occurred_at) as label, count(*) as calls,
            ${failed} as failures, epoch_ms(max(occurred_at)) as last_used
          from usage_tool_calls ${where} group by agent_key order by calls desc, agent_key limit 25`,
          params,
        ),
        read(
          `select agent_key, app_id, tool_name, count(*) as calls
          from usage_tool_calls ${where} group by agent_key, app_id, tool_name
          qualify row_number() over (partition by agent_key order by count(*) desc, tool_name) <= 5
          order by calls desc`,
          params,
        ),
        read(
          `select error_type, count(*) as total from usage_tool_calls
          ${where} and outcome = 'failure' and error_type is not null
          group by error_type order by total desc, error_type limit 10`,
          params,
        ),
      ]);
      const total = totals[0];
      const calls = total === undefined ? 0 : count(total.calls);
      return {
        totals: {
          calls,
          failures: total === undefined ? 0 : count(total.failures),
          successRate: calls === 0 || total === undefined ? 0 : count(total.successes) / calls,
          activeAgents: total === undefined ? 0 : count(total.agents),
          activeApps: total === undefined ? 0 : count(total.apps),
          avgDurationMs: total === undefined ? 0 : Math.round(Number(total.avg_duration)),
        },
        daily: daily.map((row) => ({
          date: String(row.day),
          calls: count(row.calls),
          failures: count(row.failures),
        })),
        topApps: apps.map((row) => ({
          appId: AppId.make(String(row.app_id)),
          calls: count(row.calls),
          failures: count(row.failures),
        })),
        agents: agents.map((row) => ({
          agentKey: String(row.agent_key),
          label: String(row.label),
          calls: count(row.calls),
          failures: count(row.failures),
          lastUsedAt: new Date(count(row.last_used)).toISOString(),
          topTools: tools
            .filter((tool) => tool.agent_key === row.agent_key)
            .map((tool) => ({
              appId: AppId.make(String(tool.app_id)),
              toolName: String(tool.tool_name),
              calls: count(tool.calls),
            })),
        })),
        failureTypes: failures.map((row) => ({
          errorType: String(row.error_type),
          count: count(row.total),
        })),
      } satisfies UsageAggregates;
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning("Usage records could not be read").pipe(Effect.as(emptyUsage)),
      ),
    );

  const store: typeof UsageStore.Service = {
    available: true,
    record: (call) => {
      buffer.push(call);
      if (buffer.length > bufferLimit) buffer.splice(0, buffer.length - bufferLimit);
      if (buffer.length >= flushSize) Effect.runFork(flush);
    },
    query,
  };
  return store;
}).pipe(
  // Usage records never prevent the product from starting.
  Effect.catch((cause) =>
    Effect.logWarning("Usage records are unavailable", cause).pipe(Effect.as(undefined)),
  ),
);
