/**
 * The "Task insights" organization setting: whether tool-call arguments and responses are kept with
 * the usage records, for how long, and which extra names are masked. Both are on by default for an organization that never saved the setting;
 * a database that cannot be read means nothing is recorded.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { ApiError } from "@executor-js/utils/api-error";
import { GroupsUnavailable } from "./groups.ts";
import {
  OrganizationForbidden,
  OrganizationReference,
  RequireOrganization,
} from "./organization.ts";

/** How long stored arguments and responses are kept before they are removed from their records. */
export const TaskArgumentRetentionDays = Schema.Literals([7, 30, 90]);
export type TaskArgumentRetentionDays = typeof TaskArgumentRetentionDays.Type;
export const defaultTaskArgumentRetentionDays: TaskArgumentRetentionDays = 30;
export const maxExtraMaskedKeys = 50;
export const maxExtraMaskedKeyLength = 64;

/** The setting as the dashboard edits it. */
export const TaskInsightsSettingsFields = Schema.Struct({
  /** Whether tool-call arguments are recorded. On by default. */
  recordArguments: Schema.Boolean,
  /** Whether tool-call responses are recorded. On by default, separate from arguments. */
  recordResponses: Schema.Boolean,
  retentionDays: TaskArgumentRetentionDays,
  /** Argument names masked in addition to the built-in credential names, matched in any case. */
  extraMaskedKeys: Schema.Array(Schema.String),
});
export type TaskInsightsSettingsFields = typeof TaskInsightsSettingsFields.Type;

/**
 * What a save sends. `recordResponses` may be absent so callers from before it existed keep
 * working; absent keeps the stored value.
 */
export const TaskInsightsSettingsUpdate = Schema.Struct({
  ...TaskInsightsSettingsFields.fields,
  recordResponses: Schema.optional(Schema.Boolean),
});
export type TaskInsightsSettingsUpdate = typeof TaskInsightsSettingsUpdate.Type;

export const TaskInsightsSettings = Schema.Struct({
  ...TaskInsightsSettingsFields.fields,
  /** False when this host keeps no usage records, so nothing is recorded whatever is chosen. */
  available: Schema.Boolean,
});
export type TaskInsightsSettings = typeof TaskInsightsSettings.Type;

/** What an organization that never saved the setting gets. */
export const defaultTaskInsightsSettings: TaskInsightsSettingsFields = {
  recordArguments: true,
  recordResponses: true,
  retentionDays: defaultTaskArgumentRetentionDays,
  extraMaskedKeys: [],
};

/** A masked key name is empty, too long, or there are too many. Nothing was saved. */
export const TaskInsightsSettingsInvalid = ApiError.define({
  tag: "TaskInsightsSettingsInvalid",
  status: 400,
  message: `Use up to ${maxExtraMaskedKeys} names to mask, each 1 to ${maxExtraMaskedKeyLength} characters.`,
});
export type TaskInsightsSettingsInvalid = typeof TaskInsightsSettingsInvalid.Type;

const organization = { organization: OrganizationReference };
const errors = [OrganizationForbidden, GroupsUnavailable];

/** Arguments may hold business data, so organization owners and admins alone read and change this. */
export const HostedTaskInsightsSettings = HttpApiGroup.make("taskInsightsSettings")
  .add(
    HttpApiEndpoint.get("get", "/api/organizations/:organization/task-insights-settings", {
      params: organization,
      success: TaskInsightsSettings,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.put("update", "/api/organizations/:organization/task-insights-settings", {
      params: organization,
      payload: TaskInsightsSettingsUpdate,
      success: TaskInsightsSettings,
      error: [...errors, TaskInsightsSettingsInvalid],
    }),
  )
  .middleware(RequireOrganization);
