/**
 * Host protocol 13: protocol 12 plus account scopes and app-owned schedules.
 *
 * An app declares its account requirements by scope: `app` accounts are linked by the app's
 * managers for everyone, `user` accounts by each caller. An invocation carries its accounts by
 * scope, and `user` is absent for work without a caller. An operation schedule may name the scope
 * `app`, so one run serves the app instead of one run per member. Older bundles declare user
 * requirements only. Every other message is protocol 12's, re-exported unchanged.
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

/** The JSON body the host sends to a bundle's generated server entry. */
export const HostInvocation = Schema.Struct({
  ...PreviousInvocation.fields,
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

/** Serializable live tool metadata, whose schedules may be app-owned. */
export const HostedTool = Schema.Struct({
  ...PreviousTool.fields,
  schedules: Schema.optionalKey(Schema.Array(OperationSchedule)),
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

/** Every message of protocol 13, in the order its snapshot records them. */
export const protocol13 = {
  version: 13,
  schemas: {
    ...protocol12.schemas,
    invocation: HostInvocation,
    requirements: DeclaredRequirements,
    catalog: HostedCatalog,
    catalogSummary: HostedCatalogSummary,
    accounts: ResolvedAccounts,
  },
} as const;
