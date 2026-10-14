/** Atomic setup and invitation redemption over Better Auth's transaction adapter. */
import {
  defineRequestState,
  getCurrentAdapter,
  runWithTransaction,
} from "@better-auth/core/context";
import type {
  BetterAuthOptions,
  BetterAuthPlugin,
  GenericEndpointContext,
} from "@better-auth/core";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { Cause, Effect, Exit, Schema } from "effect";
import { OrganizationSlug } from "@executor-js/hosted-server/organization";
import { z } from "zod";
import type { selfHostAuthSettings } from "./auth-options.ts";

const admittedSsoUser = defineRequestState<boolean>(() => false);

const User = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  emailVerified: Schema.Boolean,
});
const Organization = Schema.Struct({ id: Schema.String });
const Membership = Schema.Struct({ organizationId: Schema.String });
const RoleMembership = Schema.Struct({ userId: Schema.String, role: Schema.String });
const Candidate = Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String });
const Instance = Schema.Struct({
  ownerUserId: Schema.String,
  primaryOrganizationId: Schema.String,
});
const instanceKey = "instance";
const Invitation = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  organizationId: Schema.String,
  role: Schema.Literals(["admin", "member"]),
  status: Schema.String,
  expiresAt: Schema.Date,
});
const credentials = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email(),
  password: z.string().min(8).max(128),
});
const call = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      isAPIError(cause)
        ? cause
        : new APIError("SERVICE_UNAVAILABLE", {
            message: "Authentication is unavailable. Try again.",
          }),
  });
const run = <A>(effect: Effect.Effect<A, APIError>) =>
  Effect.runPromiseExit(effect).then(
    Exit.match({
      onSuccess: (value) => value,
      onFailure: (cause) => {
        throw Cause.squash(cause);
      },
    }),
  );
const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      () => new APIError("FORBIDDEN", { message: "This account cannot join the instance." }),
    ),
  );
const deny = (message: string) => Effect.fail(new APIError("FORBIDDEN", { message }));
const adapterFor = (ctx: GenericEndpointContext) =>
  call(() => getCurrentAdapter(ctx.context.adapter));
const isSsoCallback = (ctx: GenericEndpointContext) =>
  ctx.path === "/callback/:id" && ctx.params?.id === "sso";

const memberPage = 500;

/** Better Auth stores several roles as one comma-separated string. */
const administers = (role: string) =>
  role.split(",").some((part) => part === "owner" || part === "admin");

/** The persisted instance record; absent until first-run setup completes. */
const instanceRecord = (ctx: GenericEndpointContext) =>
  Effect.gen(function* () {
    const adapter = yield* adapterFor(ctx);
    const row = yield* call(() =>
      adapter.findOne({
        model: "selfHostInstance",
        where: [{ field: "key", value: instanceKey }],
      }),
    );
    return row === null ? null : yield* decode(Instance, row);
  });

/** The signed-in person, who must be the instance owner. */
const requireInstanceOwner = (ctx: GenericEndpointContext) =>
  Effect.gen(function* () {
    const session = yield* call(() => getSessionFromCtx(ctx));
    if (session === null) return yield* Effect.fail(new APIError("UNAUTHORIZED"));
    const instance = yield* instanceRecord(ctx);
    if (instance?.ownerUserId !== session.user.id)
      return yield* deny("Only the instance owner can do this.");
    return session.user;
  });

/** SSO users join the setup organization, so it must exist before an account is created. */
const primaryOrganization = (ctx: GenericEndpointContext) =>
  Effect.gen(function* () {
    const instance = yield* instanceRecord(ctx);
    if (instance === null)
      return yield* deny("This instance has not been set up. Contact its administrator.");
    const adapter = yield* adapterFor(ctx);
    const organization = yield* call(() =>
      adapter.findOne({
        model: "organization",
        where: [{ field: "id", value: instance.primaryOrganizationId }],
      }),
    );
    if (organization === null)
      return yield* deny(
        "The instance's primary organization is missing. Contact its administrator.",
      );
    return yield* decode(Organization, organization);
  });

/** Reject non-SSO user creation; only verified, allowlisted OIDC users can join automatically. */
export const selfHostUserHooks = (settings: Effect.Success<typeof selfHostAuthSettings>) =>
  ({
    user: {
      create: {
        before: (user, ctx) =>
          run(
            Effect.gen(function* () {
              if (ctx?.path === "/self-host/setup" || ctx?.path === "/self-host/register") return;
              if (!ctx || !isSsoCallback(ctx) || settings.sso === null || !user.emailVerified)
                return yield* deny("Create the first account through setup, or use an invitation.");
              const domain = user.email.toLowerCase().split("@")[1];
              if (!domain || !settings.sso.allowedDomains.includes(domain))
                return yield* deny("Use a verified account from an approved SSO domain.");
              yield* primaryOrganization(ctx);
              yield* call(() => admittedSsoUser.set(true));
            }),
          ),
      },
    },
    session: {
      create: {
        before: (session, ctx) =>
          run(
            Effect.gen(function* () {
              if (!ctx) return yield* deny("A sign-in request is required.");
              const adapter = yield* adapterFor(ctx);
              const memberships = yield* call(() =>
                adapter.findMany({
                  model: "member",
                  where: [{ field: "userId", value: session.userId }],
                  sortBy: { field: "createdAt", direction: "asc" },
                }),
              ).pipe(
                Effect.flatMap((rows) => decode(Schema.Array(Membership), rows)),
                Effect.map((rows) => rows.map((row) => row.organizationId)),
              );
              if (memberships.length === 0) {
                // Re-check the policy on every SSO login; no email/password login can auto-join.
                if (
                  !isSsoCallback(ctx) ||
                  settings.sso === null ||
                  !(yield* call(() => admittedSsoUser.get()))
                )
                  return yield* deny("Your account is not a member of this instance.");
                const user = yield* call(() =>
                  adapter.findOne({
                    model: "user",
                    where: [{ field: "id", value: session.userId }],
                  }),
                ).pipe(Effect.flatMap((value) => decode(User, value)));
                const domain = user.email.toLowerCase().split("@")[1];
                if (!user.emailVerified || !domain || !settings.sso.allowedDomains.includes(domain))
                  return yield* deny("Use a verified account from an approved SSO domain.");
                // New SSO users join the instance's primary (setup) organization as members.
                const org = yield* primaryOrganization(ctx);
                yield* call(() =>
                  adapter.create({
                    model: "member",
                    data: {
                      organizationId: org.id,
                      userId: user.id,
                      role: "member",
                      createdAt: new Date(),
                    },
                  }),
                );
                return { data: { ...session, activeOrganizationId: org.id } };
              }
              // Carry forward the active organization of their newest surviving session while
              // they still belong to it; otherwise their earliest membership. Nothing in the
              // product changes a session's active organization after sign-in, and signing out
              // deletes the row, so this is usually the earliest membership. It is only a
              // default: the product scopes every request by the organization in the URL.
              const previous = yield* call(() =>
                adapter.findMany({
                  model: "session",
                  where: [{ field: "userId", value: session.userId }],
                  sortBy: { field: "createdAt", direction: "desc" },
                  limit: 1,
                }),
              );
              const lastUsed = Schema.decodeUnknownOption(
                Schema.Array(Schema.Struct({ activeOrganizationId: Schema.NonEmptyString })),
              )(previous);
              const lastUsedId =
                lastUsed._tag === "Some" ? lastUsed.value[0]?.activeOrganizationId : undefined;
              const active =
                lastUsedId !== undefined && memberships.includes(lastUsedId)
                  ? lastUsedId
                  : memberships[0];
              return { data: { ...session, activeOrganizationId: active } };
            }),
          ),
      },
    },
  }) satisfies NonNullable<BetterAuthOptions["databaseHooks"]>;

const register = (
  ctx: GenericEndpointContext,
  input: z.infer<typeof credentials>,
  admission: { readonly organizationName: string } | { readonly invitation: string },
) =>
  run(
    call(
      async () =>
        await runWithTransaction(ctx.context.adapter, () =>
          run(
            Effect.gen(function* () {
              // PGlite reserves its only connection for this whole transaction. Concurrent
              // first-run requests therefore cannot both observe an empty user table.
              const adapter = yield* adapterFor(ctx);
              const email = input.email.toLowerCase();
              let organizationId: string;
              let role: "owner" | "admin" | "member";
              if ("organizationName" in admission) {
                const users = yield* call(() => adapter.count({ model: "user" }));
                const organizations = yield* call(() => adapter.count({ model: "organization" }));
                if (users !== 0 || organizations !== 0)
                  return yield* deny(
                    "Setup is already complete. Sign in or ask an administrator for an invitation.",
                  );
                const org = yield* call(() =>
                  adapter.create({
                    model: "organization",
                    data: {
                      name: admission.organizationName,
                      slug: "executor",
                      createdAt: new Date(),
                    },
                  }),
                ).pipe(Effect.flatMap((value) => decode(Organization, value)));
                organizationId = org.id;
                role = "owner";
              } else {
                const invitation = yield* call(() =>
                  adapter.findOne({
                    model: "invitation",
                    where: [{ field: "id", value: admission.invitation }],
                  }),
                ).pipe(Effect.flatMap((value) => decode(Invitation, value)));
                if (
                  invitation.status !== "pending" ||
                  invitation.expiresAt.getTime() <= Date.now() ||
                  invitation.email.toLowerCase() !== email
                )
                  return yield* deny(
                    "This invitation is invalid, expired, or for a different email.",
                  );
                // The invitation names its organization; it must still exist.
                const org = yield* call(() =>
                  adapter.findOne({
                    model: "organization",
                    where: [{ field: "id", value: invitation.organizationId }],
                  }),
                ).pipe(Effect.flatMap((value) => decode(Organization, value)));
                organizationId = org.id;
                role = invitation.role;
                yield* call(() =>
                  adapter.update({
                    model: "invitation",
                    where: [{ field: "id", value: invitation.id }],
                    update: { status: "accepted" },
                  }),
                );
              }
              const existing = yield* call(() =>
                ctx.context.internalAdapter.findUserByEmail(email, { includeAccounts: true }),
              );
              const user = yield* Effect.gen(function* () {
                if (existing) {
                  // A new invitation can readmit a removed member, but cannot replace their password.
                  const account = existing.accounts.find(
                    (account) => account.providerId === "credential",
                  );
                  const passwordHash = account?.password;
                  if (
                    !passwordHash ||
                    !(yield* call(() =>
                      ctx.context.password.verify({ hash: passwordHash, password: input.password }),
                    ))
                  )
                    return yield* deny("Use your existing password to accept this invitation.");
                  return existing.user;
                }
                const hash = yield* call(() => ctx.context.password.hash(input.password));
                const created = yield* call(() =>
                  ctx.context.internalAdapter.createUser(
                    { name: input.name, email, emailVerified: false },
                    { method: "email-password" },
                  ),
                );
                yield* call(() =>
                  ctx.context.internalAdapter.linkAccount({
                    userId: created.id,
                    accountId: created.id,
                    providerId: "credential",
                    password: hash,
                  }),
                );
                return created;
              });
              const alreadyMember =
                (yield* call(() =>
                  adapter.findOne({
                    model: "member",
                    where: [
                      { field: "userId", value: user.id },
                      { field: "organizationId", value: organizationId },
                    ],
                  }),
                )) !== null;
              if (!alreadyMember)
                yield* call(() =>
                  adapter.create({
                    model: "member",
                    data: { organizationId, userId: user.id, role, createdAt: new Date() },
                  }),
                );
              // Persist who completed setup; later role changes never move instance ownership.
              if ("organizationName" in admission)
                yield* call(() =>
                  adapter.create({
                    model: "selfHostInstance",
                    data: {
                      key: instanceKey,
                      ownerUserId: user.id,
                      primaryOrganizationId: organizationId,
                      createdAt: new Date(),
                    },
                  }),
                );
              const session = yield* call(() => ctx.context.internalAdapter.createSession(user.id));
              if (!session) return yield* Effect.fail(new APIError("INTERNAL_SERVER_ERROR"));
              return { user, session };
            }),
          ),
        ),
    ).pipe(
      Effect.flatMap((result) =>
        call(async () => {
          await setSessionCookie(ctx, result);
          return ctx.json({ status: true });
        }),
      ),
    ),
  );

/** Public capability discovery contains no users, emails, or SSO credentials. */
export const selfHostRegistration = (settings: Effect.Success<typeof selfHostAuthSettings>) =>
  ({
    id: "executor-self-host-registration",
    hooks: {
      before: [
        {
          // Only the instance owner creates organizations, whatever their role in any of them.
          matcher: (context) => context.path === "/organization/create",
          handler: createAuthMiddleware(async (context) => {
            const session = await getSessionFromCtx(context);
            // Without a session the native endpoint rejects HTTP callers itself.
            if (session === null) return;
            const instance = await context.context.adapter.findOne<Record<string, unknown>>({
              model: "selfHostInstance",
              where: [{ field: "key", value: instanceKey }],
            });
            if (instance?.ownerUserId !== session.user.id)
              throw new APIError("FORBIDDEN", {
                code: "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION",
                message: "Only the instance owner can create organizations.",
              });
            // Handles are URL segments; Better Auth itself only checks that one is unique.
            if (!Schema.is(OrganizationSlug)(context.body?.slug))
              throw new APIError("BAD_REQUEST", {
                code: "INVALID_ORGANIZATION_SLUG",
                message: "The handle must be lowercase letters, digits and single hyphens.",
              });
          }),
        },
      ],
    },
    endpoints: {
      selfHostMe: createAuthEndpoint("/self-host/me", { method: "GET" }, (ctx) =>
        run(
          Effect.gen(function* () {
            const session = yield* call(() => getSessionFromCtx(ctx));
            if (session === null) return yield* Effect.fail(new APIError("UNAUTHORIZED"));
            const instance = yield* instanceRecord(ctx);
            return ctx.json({ instanceOwner: instance?.ownerUserId === session.user.id });
          }),
        ),
      ),
      // People the owner may hand the instance to: owners and admins of at least one organization.
      selfHostTransferCandidates: createAuthEndpoint(
        "/self-host/transfer-candidates",
        { method: "GET" },
        (ctx) =>
          run(
            Effect.gen(function* () {
              const owner = yield* requireInstanceOwner(ctx);
              const adapter = yield* adapterFor(ctx);
              // Read every page, in a stable order, so no eligible person is left out.
              const ids = new Set<string>();
              for (let offset = 0; ; offset += memberPage) {
                const page = yield* call(() =>
                  adapter.findMany({
                    model: "member",
                    where: [
                      { field: "role", operator: "contains", value: "owner", connector: "OR" },
                      { field: "role", operator: "contains", value: "admin", connector: "OR" },
                    ],
                    sortBy: { field: "id", direction: "asc" },
                    limit: memberPage,
                    offset,
                  }),
                ).pipe(Effect.flatMap((rows) => decode(Schema.Array(RoleMembership), rows)));
                for (const row of page)
                  if (administers(row.role) && row.userId !== owner.id) ids.add(row.userId);
                if (page.length < memberPage) break;
              }
              if (ids.size === 0) return ctx.json({ candidates: [] });
              const candidates = yield* call(() =>
                adapter.findMany({
                  model: "user",
                  where: [{ field: "id", operator: "in", value: Array.from(ids) }],
                  sortBy: { field: "email", direction: "asc" },
                  limit: ids.size,
                }),
              ).pipe(Effect.flatMap((rows) => decode(Schema.Array(Candidate), rows)));
              return ctx.json({
                candidates: candidates.map(({ id, name, email }) => ({ id, name, email })),
              });
            }),
          ),
      ),
      // Ownership moves in one transaction, and only from the owner the request was checked as.
      transferSelfHostOwnership: createAuthEndpoint(
        "/self-host/transfer-ownership",
        { method: "POST", body: z.object({ userId: z.string().min(1) }) },
        (ctx) =>
          run(
            call(
              async () =>
                await runWithTransaction(ctx.context.adapter, () =>
                  run(
                    Effect.gen(function* () {
                      const owner = yield* requireInstanceOwner(ctx);
                      const adapter = yield* adapterFor(ctx);
                      const target = ctx.body.userId;
                      const invalid = (message: string) =>
                        Effect.fail(new APIError("BAD_REQUEST", { message }));
                      if (target === owner.id)
                        return yield* invalid("You already own this instance.");
                      const user = yield* call(() =>
                        adapter.findOne({ model: "user", where: [{ field: "id", value: target }] }),
                      );
                      if (user === null) return yield* invalid("That person does not exist.");
                      const roles = yield* call(() =>
                        adapter.findMany({
                          model: "member",
                          where: [{ field: "userId", value: target }],
                          limit: 1000,
                        }),
                      ).pipe(Effect.flatMap((rows) => decode(Schema.Array(RoleMembership), rows)));
                      if (!roles.some((row) => administers(row.role)))
                        return yield* invalid(
                          "Choose someone who owns or administers an organization.",
                        );
                      const moved = yield* call(() =>
                        adapter.updateMany({
                          model: "selfHostInstance",
                          where: [
                            { field: "key", value: instanceKey },
                            { field: "ownerUserId", value: owner.id },
                          ],
                          update: { ownerUserId: target },
                        }),
                      );
                      if (moved !== 1) return yield* deny("Only the instance owner can do this.");
                      return { status: true };
                    }),
                  ),
                ),
            ).pipe(Effect.map((result) => ctx.json(result))),
          ),
      ),
      selfHostConfiguration: createAuthEndpoint("/self-host/config", { method: "GET" }, (ctx) =>
        run(
          Effect.gen(function* () {
            const adapter = yield* adapterFor(ctx);
            const users = yield* call(() => adapter.count({ model: "user" }));
            const organizations = yield* call(() => adapter.count({ model: "organization" }));
            return ctx.json({
              setup: users === 0 && organizations === 0,
              sso: settings.sso !== null,
            });
          }),
        ),
      ),
      setupSelfHost: createAuthEndpoint(
        "/self-host/setup",
        {
          method: "POST",
          body: credentials.extend({ organizationName: z.string().trim().min(1).max(100) }),
        },
        (ctx) => register(ctx, ctx.body, { organizationName: ctx.body.organizationName }),
      ),
      registerSelfHost: createAuthEndpoint(
        "/self-host/register",
        { method: "POST", body: credentials.extend({ invitation: z.string().min(1) }) },
        (ctx) => register(ctx, ctx.body, { invitation: ctx.body.invitation }),
      ),
    },
  }) satisfies BetterAuthPlugin;
