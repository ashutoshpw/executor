import type { McpAppAccounts, McpTargetInput } from "./targets.ts";
import type {
  App,
  Executor,
  ToolCallResult,
  ToolPending,
  ToolResumeResult,
  ToolPage,
  SearchableTools,
  ToolSearchPage,
  ToolInvocationOptions,
  ToolListOptions,
  CatalogReadOptions,
  ElicitationFailed,
  AppSkillCatalog,
  AppSkillDocument,
  AppEventDefinition,
  AppId,
  EventCallbackFailed,
  EventDefinitionChanged,
  EventNotFound,
  EventSubscription,
  EventSubscriptionGrant,
  EventSubscriptionInvalid,
  EventSubscriptionKey,
  EventsUnavailable,
  SubscribeEvent,
} from "@executor-js/sdk/core";
import { Schema, type Effect } from "effect";
import type { BlobHandle } from "apps/contracts";

/** A subscription key without its principal: the product binds that to the caller. */
export type McpEventKey = Omit<EventSubscriptionKey, "principal">;

/** Why a subscription was refused, beside the host's own errors. */
export type McpEventError =
  | EventNotFound
  | EventDefinitionChanged
  | EventSubscriptionInvalid
  | EventCallbackFailed
  | EventsUnavailable;

/** The file is unknown to this caller: missing, expired, another organization's, or forged. */
export class FileNotFound extends Schema.TaggedError<FileNotFound>()("FileNotFound", {
  id: Schema.String,
}) {}
/** The caller's grant may not reach files. */
export class FileForbidden extends Schema.TaggedError<FileForbidden>()("FileForbidden", {}) {}
/** The file is over the bound of one `resources/read`; a signed link or the CLI moves it. */
export class FileTooLargeForResource extends Schema.TaggedError<FileTooLargeForResource>()(
  "FileTooLargeForResource",
  {
    id: Schema.String,
    size: Schema.Int,
    maximum: Schema.Int,
    sha256: Schema.String,
    url: Schema.optionalKey(Schema.String),
    expiresAt: Schema.optionalKey(Schema.String),
  },
) {}
/** This host stores no files, or its store cannot answer right now. */
export class FilesUnavailable extends Schema.TaggedError<FilesUnavailable>()(
  "FilesUnavailable",
  {},
) {}
export type McpFileError =
  | FileNotFound
  | FileForbidden
  | FileTooLargeForResource
  | FilesUnavailable;

/** What a `resource_link` states about a file. */
export interface McpFileInfo {
  readonly handle: BlobHandle;
}
/** A file's bytes as `resources/read` returns them. */
export interface McpFileContent {
  readonly handle: BlobHandle;
  readonly contents:
    | { readonly _tag: "text"; readonly text: string }
    | { readonly _tag: "blob"; readonly bytes: Uint8Array };
}

/**
 * The catalog and calls available to one authenticated caller. Products own
 * authorization on every operation; an owner filter alone is not authority.
 * Create hosted adapters per request, never cache them across callers.
 * Preserve native errors. Schema error identifiers become public diagnostics at the MCP
 * response boundary. Declared API errors have a bounded safe projection; other
 * messages, fields and causes remain private.
 */
export interface McpBackend<E extends Error> {
  /** Authorize app and account access before evaluating skill metadata. */
  readonly listSkills: (
    input: Parameters<Executor["skills"]["list"]>[0],
    options?: CatalogReadOptions,
  ) => Effect.Effect<AppSkillCatalog, E>;
  /** Reauthorize each document/reference read, including previous versions. */
  readonly readSkill: (
    input: Parameters<Executor["skills"]["read"]>[0],
  ) => Effect.Effect<AppSkillDocument, E>;
  /** Reauthorize input delivery using the current request before releasing a running tool. */
  readonly authorizeElicitation: (
    input: Pick<Parameters<Executor["tools"]["call"]>[0], "app" | "tool" | "accounts">,
  ) => Effect.Effect<void, ElicitationFailed>;
  /** Apply IDs in storage before loading app metadata. [] selects none; omitted IDs add no restriction.
   * Hosts still enforce owner access; this filter is never an authorization grant.
   */
  readonly listApps: (
    input?: Pick<NonNullable<Parameters<Executor["apps"]["list"]>[0]>, "ids"> & {
      /** Restrict the inventory to apps whose tools this caller may reach. */
      readonly toolsOnly?: boolean;
    },
  ) => Effect.Effect<ReadonlyArray<Pick<App, "id" | "name" | "slug" | "activeVersion">>, E>;
  /**
   * The caller's linked accounts for the app, by user requirement; skills use the same authority.
   * App requirements are not listed: operations name `{ app: {}, user }` and the backend fills the
   * app requirements from the app links.
   */
  readonly listAccounts: (input: McpTargetInput) => Effect.Effect<McpAppAccounts, E>;
  /** Authorize the app and its selected accounts before evaluating each catalog page. */
  readonly listTools: (
    input: Parameters<Executor["tools"]["list"]>[0],
    options?: ToolListOptions,
  ) => Effect.Effect<ToolPage, E>;
  /**
   * Authorize the app and its selected accounts as for `listTools`, then keep the target's current
   * listing as search rows. Only failed routers the caller may discover are returned.
   */
  readonly searchableTools: (
    input: Parameters<Executor["tools"]["searchable"]>[0],
    options?: ToolListOptions,
  ) => Effect.Effect<SearchableTools, E>;
  /**
   * Rank the tools of listings `searchableTools` returned to this backend. Narrow each target's
   * scopes to the tools the caller may discover, as `listTools` filters them, before ranking, so
   * pages and counts never include hidden tools; never widen them.
   */
  readonly searchTools: (
    input: Parameters<Executor["tools"]["search"]>[0],
  ) => Effect.Effect<ToolSearchPage, E>;
  /** Check execution permission again; prior discovery does not authorize this call. */
  readonly callTool: (
    input: Parameters<Executor["tools"]["call"]>[0],
    options?: ToolInvocationOptions,
  ) => Effect.Effect<ToolCallResult, E>;
  /** Authorize the app, then list the events its active version declares. */
  readonly eventDefinitions: (input: {
    readonly app: AppId;
  }) => Effect.Effect<readonly AppEventDefinition[], E>;
  /** This caller's saved subscription with the key, if any. Reveals nothing of other callers. */
  readonly findEventSubscription: (key: McpEventKey) => Effect.Effect<EventSubscription | null, E>;
  /** Authorize the target app's events for this caller, then subscribe or refresh as the caller. */
  readonly subscribeEvent: (
    input: Omit<SubscribeEvent, "key" | "subject" | "target"> & {
      readonly key: McpEventKey;
      readonly target: NonNullable<SubscribeEvent["target"]>;
    },
  ) => Effect.Effect<EventSubscriptionGrant, E | McpEventError>;
  /** Stop this caller's subscription with the key. Its app is authorized as for subscribing. */
  readonly unsubscribeEvent: (input: {
    readonly app: AppId;
    readonly key: McpEventKey;
  }) => Effect.Effect<void, E>;
  /**
   * Files tools return by handle, which `resource_link` and `resources/read` expose. Authorization
   * is the backend's: another organization's, forged, expired and (for a scoped grant) every
   * handle reads as not found or forbidden, never as a distinct answer.
   */
  readonly files: {
    /** The facts a link states about the caller's file. Fails `FileNotFound` for anything else. */
    readonly stat: (input: { readonly id: string }) => Effect.Effect<McpFileInfo, McpFileError | E>;
    /**
     * Read the whole file, at most the product's `maxResourceReadBytes`. `organization` is the
     * advisory segment of the URI; the caller's authentication decides the owner.
     */
    readonly read: (input: {
      readonly organization: string;
      readonly id: string;
    }) => Effect.Effect<McpFileContent, McpFileError | E>;
    /** The URI segment this caller's links name: the organization id, or `local`. */
    readonly organization: Effect.Effect<string, E>;
  };
  /** Reauthorize the reviewed app/accounts and current caller before consuming this exact SDK request. */
  readonly resumeInvocation: (
    request: typeof ToolPending.Type,
    response: Parameters<Executor["tools"]["resume"]>[0]["response"],
    options?: ToolInvocationOptions,
  ) => Effect.Effect<ToolResumeResult, E>;
}
