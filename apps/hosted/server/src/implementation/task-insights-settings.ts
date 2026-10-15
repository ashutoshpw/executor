/**
 * The organization's task insights setting: stored per organization, with arguments off by default.
 * The recorder reads it for every tool call through a short cache, so a change reaches new calls
 * within seconds.
 */
import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import { GroupDatabase, GroupsUnavailable } from "../contracts/groups.ts";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";
import {
  defaultTaskInsightsSettings,
  defaultTaskArgumentRetentionDays,
  maxExtraMaskedKeyLength,
  maxExtraMaskedKeys,
  TaskArgumentRetentionDays,
  TaskInsightsSettingsInvalid,
  type TaskInsightsSettings,
  type TaskInsightsSettingsFields,
} from "../contracts/task-insights-settings.ts";
import { UsageStore } from "../contracts/usage.ts";

const SettingsRow = Schema.Struct({
  record_arguments: Schema.Boolean,
  retention_days: TaskArgumentRetentionDays,
  extra_masked_keys: Schema.String,
});
const ExtraKeys = Schema.fromJsonString(Schema.Array(Schema.String));
const RetentionRow = Schema.Struct({
  organization_id: Schema.String,
  retention_days: TaskArgumentRetentionDays,
});

const decodeKeys = (text: string) =>
  Schema.decodeUnknownEffect(ExtraKeys)(text).pipe(Effect.orElseSucceed(() => []));

/**
 * The setting for an organization. An organization that never chose one gets the defaults.
 * Failures are the caller's: the recorder treats them as recording off.
 */
export const readTaskInsightsSettings = (sql: SqlClient.SqlClient, organizationId: string) =>
  sql`select record_arguments, retention_days, extra_masked_keys
    from hosted_organization_task_settings where organization_id = ${organizationId}`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SettingsRow))),
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(defaultTaskInsightsSettings)
        : decodeKeys(rows[0].extra_masked_keys).pipe(
            Effect.map((extraMaskedKeys): TaskInsightsSettingsFields => ({
              recordArguments: rows[0]?.record_arguments ?? false,
              retentionDays: rows[0]?.retention_days ?? defaultTaskArgumentRetentionDays,
              extraMaskedKeys,
            })),
          ),
    ),
  );

/**
 * How long each organization with a setting keeps arguments, for the sweep that removes older
 * ones. Organizations without a row keep the default.
 */
export const taskArgumentRetention = (sql: SqlClient.SqlClient) =>
  sql`select organization_id, retention_days from hosted_organization_task_settings`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RetentionRow))),
    Effect.map((rows) => ({
      defaultDays: defaultTaskArgumentRetentionDays,
      byOrganization: new Map(rows.map((row) => [row.organization_id, row.retention_days])),
    })),
  );

const cacheMillis = 30_000;
const failureCacheMillis = 10_000;
const cached = new Map<
  string,
  { readonly until: number; readonly settings: TaskInsightsSettingsFields }
>();

/** Drop a cached setting so the next call reads the saved one. */
export const forgetTaskInsightsSettings = (organizationId: string) => {
  cached.delete(organizationId);
};

/**
 * The setting the recorder applies to a call. Read through a short cache; a database that cannot
 * be read means arguments are not recorded.
 */
export const recordingSettings = (organizationId: string) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const hit = cached.get(organizationId);
    if (hit !== undefined && hit.until > now) return hit.settings;
    const database = yield* Effect.serviceOption(GroupDatabase);
    const settings: TaskInsightsSettingsFields | undefined =
      database._tag === "None"
        ? undefined
        : yield* database.value.pipe(
            Effect.flatMap((sql) => readTaskInsightsSettings(sql, organizationId)),
            Effect.orElseSucceed(() => undefined),
          );
    cached.set(organizationId, {
      until: now + (settings === undefined ? failureCacheMillis : cacheMillis),
      settings: settings ?? defaultTaskInsightsSettings,
    });
    return settings ?? defaultTaskInsightsSettings;
  });

/** Trim, drop empty and repeated names (in any case), and check the bounds. */
export const normalizeMaskedKeys = (keys: ReadonlyArray<string>) => {
  const names = new Map<string, string>();
  for (const key of keys) {
    const name = key.trim();
    if (name === "") continue;
    if (name.length > maxExtraMaskedKeyLength) return undefined;
    if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  return names.size > maxExtraMaskedKeys ? undefined : [...names.values()];
};

const view = (fields: TaskInsightsSettingsFields, available: boolean): TaskInsightsSettings => ({
  ...fields,
  available,
});

const database = Effect.flatten(GroupDatabase);

/** What changed, without the names of masked keys: only that they changed and how many there are. */
const auditChange = (before: TaskInsightsSettingsFields, after: TaskInsightsSettingsFields) =>
  JSON.stringify({
    ...(before.recordArguments === after.recordArguments
      ? {}
      : { recordArguments: { from: before.recordArguments, to: after.recordArguments } }),
    ...(before.retentionDays === after.retentionDays
      ? {}
      : { retentionDays: { from: before.retentionDays, to: after.retentionDays } }),
    ...(JSON.stringify(before.extraMaskedKeys) === JSON.stringify(after.extraMaskedKeys)
      ? {}
      : {
          extraMaskedKeys: {
            from: before.extraMaskedKeys.length,
            to: after.extraMaskedKeys.length,
          },
        }),
  });

/** Typed handlers; only owners and admins read or change the setting. */
export const hostedTaskInsightsSettingsHandlers = HttpApiBuilder.group(
  HostedApi,
  "taskInsightsSettings",
  (handlers) =>
    handlers
      .handle("get", () =>
        Effect.gen(function* () {
          const access = yield* CurrentOrganization;
          if (access.role === "member") return yield* new OrganizationForbidden();
          const sql = yield* database;
          const store = yield* UsageStore;
          const settings = yield* readTaskInsightsSettings(sql, access.organization).pipe(
            Effect.mapError(() => new GroupsUnavailable()),
          );
          return view(settings, store.available);
        }),
      )
      .handle("update", ({ payload }) =>
        Effect.gen(function* () {
          const access = yield* CurrentOrganization;
          if (access.role === "member") return yield* new OrganizationForbidden();
          const extraMaskedKeys = normalizeMaskedKeys(payload.extraMaskedKeys);
          if (extraMaskedKeys === undefined) return yield* new TaskInsightsSettingsInvalid();
          const next: TaskInsightsSettingsFields = {
            recordArguments: payload.recordArguments,
            retentionDays: payload.retentionDays,
            extraMaskedKeys,
          };
          const sql = yield* database;
          const unavailable = Effect.mapError(() => new GroupsUnavailable());
          const before = yield* readTaskInsightsSettings(sql, access.organization).pipe(
            unavailable,
          );
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`insert into hosted_organization_task_settings
                (organization_id, record_arguments, retention_days, extra_masked_keys)
                values (${access.organization}, ${next.recordArguments}, ${next.retentionDays},
                  ${JSON.stringify(next.extraMaskedKeys)})
                on conflict (organization_id) do update
                  set record_arguments = excluded.record_arguments,
                    retention_days = excluded.retention_days,
                    extra_masked_keys = excluded.extra_masked_keys,
                    updated_at = now()`;
                const change = auditChange(before, next);
                if (change !== "{}") {
                  const actor = yield* CurrentUserId;
                  yield* sql`insert into hosted_organization_setting_audit
                  (id, organization_id, actor_user_id, setting, change)
                  values (${crypto.randomUUID()}, ${access.organization}, ${actor ?? "unknown"},
                    ${"task_insights"}, ${change})`;
                }
              }),
            )
            .pipe(unavailable);
          forgetTaskInsightsSettings(access.organization);
          const store = yield* UsageStore;
          // A shorter retention applies now, not at the next scheduled sweep.
          if (next.retentionDays < before.retentionDays)
            yield* store.scrubArguments({
              byOrganization: new Map([[access.organization, next.retentionDays]]),
            });
          return view(next, store.available);
        }),
      ),
);
