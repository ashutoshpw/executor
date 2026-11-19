/**
 * Host protocol 14: protocol 13 plus credential hosts that may hold an underscore, setup guides on
 * auth methods and `pkce: false` on a declared authorization endpoint.
 *
 * A credential host's labels may hold underscores, as Docker container and service names do
 * (`n8n_server_1:5678`). A `secrets` method may carry a `guide`, and an OAuth method a
 * `clientGuide`: Markdown the connect form shows. A declared OAuth endpoint may sign in without
 * PKCE. Bundles before it declare none of these. Every other message is protocol 13's,
 * re-exported unchanged.
 *
 * Once released this protocol is frozen like the earlier ones: `bun run check` compares `protocol14`
 * with `packages/apps/protocols/14.json`. The module imports only `effect` and earlier protocol
 * modules, so no change elsewhere can alter it. Define the next protocol instead of editing this
 * file. See notes/apps-publishing.md.
 */
import { Schema } from "effect";
import { JsonObject } from "./1.ts";
import { OAuth2Config } from "./oauth-14.ts";
import {
  DeclaredRequirements as PreviousRequirements,
  HostInvocation as PreviousInvocation,
  Placements,
  ResolvedAccount as PreviousAccount,
  protocol13,
} from "./13.ts";

export * from "./13.ts";

/**
 * Where a provider's credentials may be sent: an exact host, `host:port`, or `*.` followed by a
 * domain, matching exactly one more label. Lowercase, without a scheme or path. Labels may hold
 * underscores, as Docker container and service names do (`n8n_server_1:5678`); URLs keep them.
 */
export const CredentialHost = Schema.Union([
  Schema.String.check(
    Schema.isPattern(
      /^(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[0-9]{1,5})?$/,
    ),
  ),
  Schema.String.check(
    Schema.isPattern(
      /^(\*\.)?[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*(?::[0-9]{1,5})?$/,
    ),
  ),
]);

/**
 * Field names an auth method exposes to app code, and where its secret fields may be sent. Every
 * other string field is secret.
 */
const exposure = {
  plain: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  raw: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  request: Schema.optionalKey(Placements),
};

/**
 * Markdown the connect form shows where a user enters an OAuth client for this service: where to
 * create one and what to choose there. Setup help, not part of the provider.
 */
const clientGuide = { clientGuide: Schema.optionalKey(Schema.String) };

/** Serializable authentication declarations interpreted by the trusted host. */
export const DeclaredAuthMethod = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("secrets"),
    label: Schema.String,
    /** Markdown the connect form shows above the fields. Setup help, not part of the provider. */
    guide: Schema.optionalKey(Schema.String),
    fields: JsonObject,
    ...exposure,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[0].fields,
    ...clientGuide,
    response: JsonObject,
    ...exposure,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[1].fields,
    ...clientGuide,
    response: JsonObject,
    ...exposure,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[2].fields,
    ...clientGuide,
    response: JsonObject,
    ...exposure,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth2"),
    ...OAuth2Config.members[3].fields,
    ...clientGuide,
    response: JsonObject,
    ...exposure,
  }),
]);
export type DeclaredAuthMethod = typeof DeclaredAuthMethod.Type;

/** A credential-free provider declaration with the hosts its credentials may be sent to. */
export const DeclaredProvider = Schema.Struct({
  name: Schema.NonEmptyString,
  auth: Schema.Record(Schema.NonEmptyString, DeclaredAuthMethod),
  hosts: Schema.optionalKey(Schema.Array(CredentialHost)),
});
export type DeclaredProvider = typeof DeclaredProvider.Type;

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

/** Protocol 13's requirements, with providers that may declare these hosts and guides. */
export const DeclaredRequirements = Schema.Struct({
  ...PreviousRequirements.fields,
  accounts: Schema.Struct({ app: DeclaredAccountSlots, user: DeclaredAccountSlots }),
});
export type DeclaredRequirements = typeof DeclaredRequirements.Type;

/** Host-resolved credentials for one stable saved account. */
export const ResolvedAccount = Schema.Struct({
  ...PreviousAccount.fields,
  provider: DeclaredProvider,
});
export type ResolvedAccount = typeof ResolvedAccount.Type;

/** One scope's resolved accounts by requirement; [] differs from a missing slot. */
export const ResolvedAccountSlots = Schema.Record(
  Schema.NonEmptyString,
  Schema.Union([ResolvedAccount, Schema.Array(ResolvedAccount)]),
);
export type ResolvedAccountSlots = typeof ResolvedAccountSlots.Type;

/** An invocation's accounts by scope. `user` is absent for work without a caller. */
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

/** Every message of protocol 14, in the order its snapshot records them. */
export const protocol14 = {
  version: 14,
  schemas: {
    invocation: HostInvocation,
    request: protocol13.schemas.request,
    response: protocol13.schemas.response,
    requirements: DeclaredRequirements,
    catalog: protocol13.schemas.catalog,
    catalogSummary: protocol13.schemas.catalogSummary,
    sharedCatalog: protocol13.schemas.sharedCatalog,
    skills: protocol13.schemas.skills,
    elicitationRequest: protocol13.schemas.elicitationRequest,
    elicitationReply: protocol13.schemas.elicitationReply,
    workflowStep: protocol13.schemas.workflowStep,
    workflowStepReply: protocol13.schemas.workflowStepReply,
    workflowControl: protocol13.schemas.workflowControl,
    cacheCommand: protocol13.schemas.cacheCommand,
    cacheReply: protocol13.schemas.cacheReply,
    accountCheck: protocol13.schemas.accountCheck,
    accounts: ResolvedAccounts,
    migrate: protocol13.schemas.migrate,
  },
} as const;
