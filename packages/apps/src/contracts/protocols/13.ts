/**
 * Host protocol 13: protocol 12 plus account scopes and app-owned schedules.
 *
 * An app declares its account requirements by scope: `app` accounts are linked by the app's
 * managers for everyone, `user` accounts by each caller. An invocation carries its accounts by
 * scope, and `user` is absent for work without a caller. An operation schedule may name the scope
 * `app`, so one run serves the app instead of one run per member. Older bundles declare user
 * requirements only. A tool may state `kindConfirmed`, and a build that declares the
 * `sharedDefinitions` capability may answer an inspection with a shared catalog, each schema
 * `$defs` entry sent once. Every other message is protocol 12's, re-exported unchanged.
 *
 * This protocol declares no `jwt_bearer` OAuth method: its bundles never read one, and the host
 * sends them an account whose provider uses it as the `secrets` method it behaves as.
 *
 * Once released this protocol is frozen like the earlier ones: `bun run check` compares `protocol13`
 * with `packages/apps/protocols/13.json`. The module imports only `effect` and earlier protocol
 * modules, so no change elsewhere can alter it. Define the next protocol instead of editing this
 * file. See notes/apps-publishing.md.
 */
import { Schema } from "effect";
import { JsonValue, ScheduleTiming } from "./1.ts";
import {
  DeclaredProvider,
  DeclaredRequirements as PreviousRequirements,
  HostedTool as PreviousTool,
  HostInvocation as PreviousInvocation,
  HostedCatalog as PreviousCatalog,
  HostedCatalogSummary as PreviousCatalogSummary,
  HostRequest as PreviousRequest,
  HostedRouter,
  ResolvedAccount,
  protocol12,
} from "./12.ts";

export * from "./12.ts";

/** One requirement: its provider, how many accounts it takes, and whether it has a check. */
export const DeclaredAccountSlot = Schema.Struct({
  definition: DeclaredProvider,
  cardinality: Schema.Literals(["one", "many"]),
  health: Schema.optionalKey(Schema.Literal(true)),
});
export type DeclaredAccountSlot = typeof DeclaredAccountSlot.Type;

/** One scope's requirements, by name. */
export const DeclaredAccountSlots = Schema.Record(Schema.NonEmptyString, DeclaredAccountSlot);
export type DeclaredAccountSlots = typeof DeclaredAccountSlots.Type;

/**
 * Protocol 12's requirements, with the accounts declared by scope. A name is used in one scope
 * only.
 */
export const DeclaredRequirements = Schema.Struct({
  ...PreviousRequirements.fields,
  /** Protocol support of this retained framework build, not an author-declared requirement. */
  capabilities: Schema.optionalKey(
    Schema.Struct({
      skills: Schema.Literal(true),
      /** Accepts inspect detail and tools. Earlier builds reject both as excess fields. */
      toolIndex: Schema.optionalKey(Schema.Literal(true)),
      /** Accepts skills sources and reports whether the catalog includes a live loader. */
      skillSources: Schema.optionalKey(Schema.Literal(true)),
      /** Accepts scheduled inspection. Earlier builds reject it as an excess field. */
      scheduledTools: Schema.optionalKey(Schema.Literal(true)),
      /**
       * Accepts inspect definitions and answers it with a shared catalog. Earlier builds reject it
       * as an excess field.
       */
      sharedDefinitions: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
  accounts: Schema.Struct({ app: DeclaredAccountSlots, user: DeclaredAccountSlots }),
});
export type DeclaredRequirements = typeof DeclaredRequirements.Type;

/** One scope's resolved accounts by requirement; [] differs from a missing slot. */
export const ResolvedAccountSlots = Schema.Record(
  Schema.NonEmptyString,
  Schema.Union([ResolvedAccount, Schema.Array(ResolvedAccount)]),
);
export type ResolvedAccountSlots = typeof ResolvedAccountSlots.Type;

/**
 * An invocation's accounts by scope, resolved by the trusted caller. `user` is absent for work
 * without a caller, such as an app schedule or an app-account webhook.
 */
export const ResolvedAccounts = Schema.Struct({
  app: ResolvedAccountSlots,
  user: Schema.optionalKey(ResolvedAccountSlots),
});
export type ResolvedAccounts = typeof ResolvedAccounts.Type;

const [workflowCommand, webhookCommand, requirementsCommand, , ...otherCommands] =
  PreviousRequest.members;

/** Protocol 12's inspection, which may also ask for a shared catalog. */
export const InspectCommand = Schema.Struct({
  operation: Schema.Literal("inspect"),
  /** Omit schemas. Only builds that declare the toolIndex capability accept this. */
  detail: Schema.optionalKey(Schema.Literal("summary")),
  /** Describe only these tools. Only builds that declare the toolIndex capability accept this. */
  tools: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /**
   * Describe only declared operations that have schedules, without dynamic tool discovery.
   * Only builds that declare the scheduledTools capability accept this.
   */
  scheduled: Schema.optionalKey(Schema.Literal(true)),
  /**
   * Answer with a HostedSharedCatalog, each shared `$defs` entry sent once. Only builds that
   * declare the sharedDefinitions capability accept this.
   */
  definitions: Schema.optionalKey(Schema.Literal("shared")),
});
export type InspectCommand = typeof InspectCommand.Type;

/** Framework-owned dispatch, independent of app-authored HTTP routing. */
export const HostRequest = Schema.Union([
  workflowCommand,
  webhookCommand,
  requirementsCommand,
  InspectCommand,
  ...otherCommands,
]);
export type HostRequest = typeof HostRequest.Type;

/** The JSON body the host sends to a bundle's generated server entry. */
export const HostInvocation = Schema.Struct({
  ...PreviousInvocation.fields,
  command: HostRequest,
  accounts: ResolvedAccounts,
});
export type HostInvocation = typeof HostInvocation.Type;

/** A named trigger attached to the mutation it invokes; `scope: "app"` runs it once for the app. */
export const OperationSchedule = Schema.Struct({
  name: Schema.NonEmptyString,
  scope: Schema.optionalKey(Schema.Literal("app")),
  timing: ScheduleTiming,
  input: JsonValue,
});
export type OperationSchedule = typeof OperationSchedule.Type;

/**
 * Serializable live tool metadata, whose schedules may be app-owned. `kindConfirmed` marks a kind
 * that the app's code or the tool's protocol fixes, such as a declared operation, a `kinds` entry
 * or an HTTP method, rather than an upstream claim such as an MCP server's `readOnlyHint`.
 * Executor tells an agent that a call only read only when both are set.
 */
export const HostedTool = Schema.Struct({
  schedules: Schema.optionalKey(Schema.Array(OperationSchedule)),
  name: PreviousTool.fields.name,
  router: PreviousTool.fields.router,
  tags: PreviousTool.fields.tags,
  description: PreviousTool.fields.description,
  inputSchema: PreviousTool.fields.inputSchema,
  readOnly: PreviousTool.fields.readOnly,
  kindConfirmed: Schema.optionalKey(Schema.Boolean),
  title: PreviousTool.fields.title,
  outputSchema: PreviousTool.fields.outputSchema,
  annotations: PreviousTool.fields.annotations,
  _meta: PreviousTool.fields._meta,
});
export type HostedTool = typeof HostedTool.Type;

/** Catalog entry without schemas. Browsing lists these and reads one full tool on selection. */
export const HostedToolSummary = HostedTool.mapFields(
  ({ inputSchema: _input, outputSchema: _output, _meta, ...fields }) => fields,
);
export type HostedToolSummary = typeof HostedToolSummary.Type;

/** A live evaluation's tools and the routers that group them. */
export const HostedCatalog = Schema.Struct({
  ...PreviousCatalog.fields,
  tools: Schema.Array(HostedTool),
});
export type HostedCatalog = typeof HostedCatalog.Type;

/** A catalog without tool schemas. */
export const HostedCatalogSummary = Schema.Struct({
  ...PreviousCatalogSummary.fields,
  tools: Schema.Array(HostedToolSummary),
});
export type HostedCatalogSummary = typeof HostedCatalogSummary.Type;

/** A tool schema whose `$defs` a shared catalog sends once, beside its tools. */
export const SharedSchemaKey = Schema.Literals(["inputSchema", "outputSchema"]);
export type SharedSchemaKey = typeof SharedSchemaKey.Type;

/**
 * A tool of a shared catalog. The `$defs` of each schema `shared` names is the position of its
 * entries in the catalog's `defs`; the tool's other fields are as `HostedTool`'s.
 */
export const HostedSharedTool = Schema.Struct({
  ...HostedTool.fields,
  shared: Schema.optionalKey(Schema.Array(SharedSchemaKey)),
});
export type HostedSharedTool = typeof HostedSharedTool.Type;

/**
 * A catalog that sends each `$defs` its tools' schemas hold once, and each definition in them
 * once. Putting each tool's `$defs` back gives the `HostedCatalog` the bundle evaluated. Only
 * builds that declare the sharedDefinitions capability send it, and only when the inspection asks.
 */
export const HostedSharedCatalog = Schema.Struct({
  tools: Schema.Array(HostedSharedTool),
  routers: Schema.Array(HostedRouter),
  definitions: Schema.Array(JsonValue),
  /** Each distinct `$defs`, its entries naming positions in `definitions`. */
  defs: Schema.Array(Schema.Record(Schema.String, Schema.Int)),
});
export type HostedSharedCatalog = typeof HostedSharedCatalog.Type;

/** Every message of protocol 13, in the order its snapshot records them. */
export const protocol13 = {
  version: 13,
  schemas: {
    ...protocol12.schemas,
    invocation: HostInvocation,
    requirements: DeclaredRequirements,
    catalog: HostedCatalog,
    catalogSummary: HostedCatalogSummary,
    sharedCatalog: HostedSharedCatalog,
    request: HostRequest,
    accounts: ResolvedAccounts,
  },
} as const;
