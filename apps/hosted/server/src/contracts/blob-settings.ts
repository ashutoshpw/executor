/** How long an organization keeps the files its apps store: the "Blob" organization setting. */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { ApiError } from "@executor-js/utils/api-error";
import {
  defaultBlobTtlSeconds,
  maxBlobTtlSeconds,
  minBlobTtlSeconds,
} from "@executor-js/sdk/blobs";
import { GroupsUnavailable } from "./groups.ts";
import {
  OrganizationForbidden,
  OrganizationReference,
  RequireOrganization,
} from "./organization.ts";

export { defaultBlobTtlSeconds, maxBlobTtlSeconds, minBlobTtlSeconds };

/** The lifetime of new file handles, with the bounds and default the dashboard offers. */
export const BlobSettings = Schema.Struct({
  ttlSeconds: Schema.Int,
  defaultTtlSeconds: Schema.Int,
  minTtlSeconds: Schema.Int,
  maxTtlSeconds: Schema.Int,
  /** Whether the caller may change it: organization owners and admins. */
  canEdit: Schema.Boolean,
});
export type BlobSettings = typeof BlobSettings.Type;

/** A lifetime to save. The bounds are checked by the server, which states them in the error. */
export const BlobSettingsUpdate = Schema.Struct({ ttlSeconds: Schema.Int });

/** The lifetime is outside the supported range. Nothing was saved. */
export const BlobTtlOutOfRange = ApiError.define({
  tag: "BlobTtlOutOfRange",
  status: 400,
  message: "File lifetime must be between 1 hour and 365 days.",
});
export type BlobTtlOutOfRange = typeof BlobTtlOutOfRange.Type;

const organization = { organization: OrganizationReference };
const errors = [OrganizationForbidden, GroupsUnavailable];

/** Reads need membership; saving needs a current owner or admin role. */
export const HostedBlobSettings = HttpApiGroup.make("blobSettings")
  .add(
    HttpApiEndpoint.get("get", "/api/organizations/:organization/blob-settings", {
      params: organization,
      success: BlobSettings,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.put("update", "/api/organizations/:organization/blob-settings", {
      params: organization,
      payload: BlobSettingsUpdate,
      success: BlobSettings,
      error: [...errors, BlobTtlOutOfRange],
    }),
  )
  .middleware(RequireOrganization);
