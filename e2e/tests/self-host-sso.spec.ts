/** Self-host SSO admission against a real OpenID Connect provider serving HTTPS. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestLive, withCase } from "../support/case.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { instanceClient } from "../support/self-host-instance.ts";
import { selfHostSsoProvider, ssoDomain } from "../support/self-host-sso.ts";
import { scenarios } from "../test-plan.ts";

const Organizations = Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String }));
const Members = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      role: Schema.String,
      user: Schema.Struct({ email: Schema.String }),
    }),
  ),
});
const Session = Schema.Struct({
  session: Schema.Struct({ activeOrganizationId: Schema.String }),
  user: Schema.Struct({ email: Schema.String }),
});
const Identified = Schema.Struct({ id: Schema.String });

layer(TestLive, { excludeTestServices: true })("Self-host SSO", (it) => {
  it.effect(scenarios.selfHostSsoAutoJoin.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const idp = yield* selfHostSsoProvider;
        const origin = yield* startFreshSelfHost(target, idp.environment);
        const { request, decode } = instanceClient(origin);
        const owner = {
          name: "Synthetic Owner",
          email: `owner@${ssoDomain}`,
          password: "Synthetic-e2e-password-2026",
        };
        const setup = yield* request("", "POST", "/api/auth/self-host/setup", {
          ...owner,
          organizationName: "Synthetic primary",
        });
        expect(setup.status).toBe(200);
        const ownerCookie = setup.cookie;
        const organizationsOf = (cookie: string) =>
          request(cookie, "GET", "/api/auth/organization/list").pipe(
            Effect.flatMap((response) => decode(Organizations, response.body)),
            Effect.map((rows) => rows.map((row) => row.slug)),
          );
        const membersOf = (organizationId: string) =>
          request(
            ownerCookie,
            "GET",
            `/api/auth/organization/list-members?organizationId=${organizationId}`,
          ).pipe(
            Effect.flatMap((response) => decode(Members, response.body)),
            Effect.map((view) => view.members),
          );
        const [primary] = yield* request(ownerCookie, "GET", "/api/auth/organization/list").pipe(
          Effect.flatMap((response) => decode(Organizations, response.body)),
        );
        if (primary === undefined) return yield* Effect.die("Setup created no organization");
        // Other organizations exist, so joining "the first one" would not be the setup one.
        const other = yield* request(ownerCookie, "POST", "/api/auth/organization/create", {
          name: "Other team",
          slug: "other-team",
          keepCurrentActiveOrganization: true,
        });
        expect(other.status).toBe(200);
        const otherId = (yield* decode(Identified, other.body)).id;

        // Sign-in is rate limited per address (3 per 10 seconds), so the disallowed domain
        // is tried last, after the window has passed.
        // A brand-new allowlisted person joins the setup organization as a member, and nowhere else.
        const newcomer = `newcomer@${ssoDomain}`;
        const first = yield* idp.signIn(origin, newcomer);
        expect(first.cookie, "SSO signs the newcomer in").not.toBe("");
        expect(yield* organizationsOf(first.cookie)).toEqual([primary.slug]);
        expect(
          (yield* membersOf(primary.id)).find((member) => member.user.email === newcomer)?.role,
        ).toBe("member");
        expect((yield* membersOf(otherId)).map((member) => member.user.email)).toEqual([
          owner.email,
        ]);
        const session = yield* request(first.cookie, "GET", "/api/auth/get-session").pipe(
          Effect.flatMap((response) => decode(Session, response.body)),
        );
        expect(session.session.activeOrganizationId).toBe(primary.id);

        // A person who now belongs only to another organization signs in there, and is not
        // added to the setup organization again.
        const returning = `returning@${ssoDomain}`;
        const joined = yield* idp.signIn(origin, returning);
        const invitation = yield* request(
          ownerCookie,
          "POST",
          "/api/auth/organization/invite-member",
          { organizationId: otherId, email: returning, role: "member" },
        ).pipe(Effect.flatMap((response) => decode(Identified, response.body)));
        expect(
          (yield* request(joined.cookie, "POST", "/api/auth/organization/accept-invitation", {
            invitationId: invitation.id,
          })).status,
        ).toBe(200);
        expect(
          (yield* request(ownerCookie, "POST", "/api/auth/organization/remove-member", {
            organizationId: primary.id,
            memberIdOrEmail: returning,
          })).status,
        ).toBe(200);
        expect(
          (yield* membersOf(primary.id)).some((member) => member.user.email === returning),
        ).toBe(false);
        const again = yield* idp.signIn(origin, returning);
        expect(again.cookie, "SSO signs the returning person in").not.toBe("");
        expect(yield* organizationsOf(again.cookie)).toEqual(["other-team"]);
        expect(
          (yield* membersOf(primary.id)).some((member) => member.user.email === returning),
          "Signing in does not add them to the setup organization",
        ).toBe(false);
        const landed = yield* request(again.cookie, "GET", "/api/auth/get-session").pipe(
          Effect.flatMap((response) => decode(Session, response.body)),
        );
        expect(landed.session.activeOrganizationId).toBe(otherId);

        // A person outside the allowlist is refused and gets no account.
        yield* Effect.sleep("11 seconds");
        const outsider = yield* idp.signIn(origin, "outsider@elsewhere.example");
        expect(outsider.cookie, "SSO refuses a disallowed domain").toBe("");
        expect(
          (yield* membersOf(primary.id)).some((member) =>
            member.user.email.startsWith("outsider@"),
          ),
        ).toBe(false);
      }),
    ),
  );
});
