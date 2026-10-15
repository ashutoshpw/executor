/**
 * The Files page: the files an organization's apps keep, as the caller may see them. Owners and
 * admins see every complete, unexpired file; a member sees the files of apps they can use. The
 * bytes move over the file transfer routes, which apply the same visibility.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { ApiError } from "@executor-js/utils/api-error";
import { AppId, StorageError } from "@executor-js/sdk/core";
import { FileNotFound, FilesUnavailable } from "@executor-js/app-management/contracts";
import { RequiredAction } from "./authorization.ts";
import {
  OrganizationForbidden,
  OrganizationReference,
  RequireOrganization,
} from "./organization.ts";

export { FileNotFound, FilesUnavailable };

/** The page cursor is not one this host issued. */
export const FilesCursorInvalid = ApiError.define({
  tag: "FilesCursorInvalid",
  status: 400,
  message: "This page cursor is not valid. Start again from the first page.",
});
export type FilesCursorInvalid = typeof FilesCursorInvalid.Type;

/** The most files one page lists, and how many it lists when the caller names no limit. */
export const maxFilesPageSize = 100;
export const defaultFilesPageSize = 50;

/** A file's app, named when the app still exists. */
export const FileApp = Schema.Struct({ id: AppId, name: Schema.NullOr(Schema.String) });

/** One file. Files carry no name of their own: a name exists only on a download link. */
export const FileEntry = Schema.Struct({
  id: Schema.String,
  contentType: Schema.String,
  size: Schema.Int,
  sha256: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  /** Null for a file uploaded over HTTP or the CLI; its `name` is null once the app is deleted. */
  app: Schema.NullOr(FileApp),
});
export type FileEntry = typeof FileEntry.Type;

export const FilesPage = Schema.Struct({
  files: Schema.Array(FileEntry),
  /** Pass as `after` for the following page; null on the last page. */
  next: Schema.NullOr(Schema.String),
  /** The apps the caller may filter by. */
  apps: Schema.Array(Schema.Struct({ id: AppId, name: Schema.String })),
  /** Whether the caller may delete files: organization owners and admins. */
  canDelete: Schema.Boolean,
});
export type FilesPage = typeof FilesPage.Type;

const organization = { organization: OrganizationReference };
const errors = [OrganizationForbidden, FilesUnavailable, StorageError];

export const HostedOrganizationFiles = HttpApiGroup.make("organizationFiles")
  .add(
    HttpApiEndpoint.get("list", "/api/organizations/:organization/files", {
      params: organization,
      query: {
        limit: Schema.optional(
          Schema.FiniteFromString.check(
            Schema.isInt(),
            Schema.isBetween({ minimum: 1, maximum: maxFilesPageSize }),
          ),
        ),
        after: Schema.optional(Schema.NonEmptyString),
        app: Schema.optional(AppId),
      },
      success: FilesPage,
      error: [...errors, FilesCursorInvalid],
    }).annotate(RequiredAction, "read"),
  )
  .add(
    // Not `/files/:handle`: a GET there downloads the bytes.
    HttpApiEndpoint.get("get", "/api/organizations/:organization/files/:handle/details", {
      params: { ...organization, handle: Schema.NonEmptyString },
      success: FileEntry,
      error: [...errors, FileNotFound],
    }).annotate(RequiredAction, "read"),
  )
  .add(
    HttpApiEndpoint.delete("delete", "/api/organizations/:organization/files/:handle", {
      params: { ...organization, handle: Schema.NonEmptyString },
      success: HttpApiSchema.NoContent,
      error: [...errors, FileNotFound],
    }).annotate(RequiredAction, "manage"),
  )
  .middleware(RequireOrganization);
