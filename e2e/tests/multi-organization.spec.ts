/** Self-host organizations: owner-only creation, isolation, and joining by invitation. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { Actors, password } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Organization, Resource } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";

const Groups = Schema.Struct({
  groups: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});

layer(HostedLive, { excludeTestServices: true })("Self-host organizations", (it) => {
  it.effect(scenarios.multiOrganization.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const suffix = randomUUID().slice(0, 8);
        const organizations = (session: Session) =>
          api
            .request(session, "GET", "/api/auth/organization/list")
            .pipe(Effect.flatMap((response) => body(Schema.Array(Organization), response)));
        const create = (session: Session, slug: string) =>
          api.request(session, "POST", "/api/auth/organization/create", {
            name: `Org ${slug}`,
            slug,
            keepCurrentActiveOrganization: true,
          });
        const groups = (session: Session, organization: string) =>
          api.request(session, "GET", `/api/organizations/${organization}/groups`);
        const invite = (organizationId: string, email: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "POST",
              "/api/auth/organization/invite-member",
              { organizationId, email, role: "member" },
            );
            expect(response.status).toBe(200);
            return (yield* body(Resource, response)).id;
          });

        // Only the instance owner creates organizations; an administrator of the setup
        // organization and a member are refused by the server, whatever the interface shows.
        const refused = `refused-${suffix}`;
        expect((yield* create(actors.admin, refused)).status).toBe(403);
        expect((yield* create(actors.member, refused)).status).toBe(403);
        expect((yield* organizations(actors.owner)).some((item) => item.slug === refused)).toBe(
          false,
        );
        // The server tells each person whether they are the instance owner; the interface
        // trusts that answer, and a person without a session is not told at all.
        const ownerOf = (session: Session) =>
          api.request(session, "GET", "/api/auth/self-host/me").pipe(
            Effect.flatMap((response) =>
              body(Schema.Struct({ instanceOwner: Schema.Boolean }), response),
            ),
            Effect.map((view) => view.instanceOwner),
          );
        expect(
          (yield* api.request(yield* api.session(), "GET", "/api/auth/self-host/me")).status,
        ).toBe(401);
        expect(yield* ownerOf(actors.owner)).toBe(true);
        expect(yield* ownerOf(actors.admin)).toBe(false);
        expect(yield* ownerOf(actors.member)).toBe(false);
        yield* browser.login(actors.admin);
        yield* browser.use("Open the switcher as an administrator", (page) =>
          Promise.all([
            // The entry is absent while the answer loads too, so look only once it has arrived
            // and the page has painted with it.
            page.waitForResponse(
              (response) =>
                response.url().endsWith("/api/auth/self-host/me") && response.status() === 200,
            ),
            page.goto(`/org/${actors.organization.slug}/apps`),
          ])
            .then(() => page.getByRole("button", { name: /^Organization:/ }).click())
            .then(() =>
              page.getByRole("menuitemradio", { name: "Evidence lab", exact: true }).waitFor(),
            )
            .then(() =>
              page.evaluate(
                () =>
                  new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                  ),
              ),
            ),
        );
        expect(
          yield* browser.use("Count creation entries", (page) =>
            page.getByRole("menuitem", { name: "Create organization", exact: true }).count(),
          ),
        ).toBe(0);

        // The owner creates a second organization in the interface and lands in it.
        const slug = `second-${suffix}`;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the switcher as the owner", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/apps`)
            .then(() => page.getByRole("button", { name: /^Organization:/ }).click()),
        );
        yield* browser.use("Choose to create an organization", (page) =>
          page.getByRole("menuitem", { name: "Create organization", exact: true }).click(),
        );
        yield* browser.use("Name the organization", (page) =>
          page.getByRole("dialog").getByLabel("Name", { exact: true }).fill(`Org ${slug}`),
        );
        yield* browser.use("Set its handle", (page) =>
          page.getByRole("dialog").getByLabel("Handle", { exact: true }).fill(slug),
        );
        yield* browser.use("Save the organization", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: "Create organization", exact: true })
            .click(),
        );
        yield* browser.use("The new organization opens", (page) =>
          page.waitForURL(`**/org/${slug}`),
        );
        const second = (yield* organizations(actors.owner)).find((item) => item.slug === slug);
        if (second === undefined) throw new Error("The second organization was not created");
        // The creator owns the new organization.
        const Members = Schema.Struct({
          members: Schema.Array(
            Schema.Struct({ role: Schema.String, user: Schema.Struct({ email: Schema.String }) }),
          ),
        });
        const membersOf = (organizationId: string) =>
          api
            .request(
              actors.owner,
              "GET",
              `/api/auth/organization/list-members?organizationId=${organizationId}`,
            )
            .pipe(
              Effect.flatMap((response) => body(Members, response)),
              Effect.map((view) => view.members.map((member) => [member.user.email, member.role])),
            );
        expect(yield* membersOf(second.id)).toEqual([["owner@example.test", "owner"]]);
        // Handles must be valid URL segments, and a taken handle is refused; deletion stays
        // unavailable.
        for (const malformed of [
          "Upper-Case",
          "has space",
          "-leading",
          "trailing-",
          "a--b",
          "x".repeat(46),
        ])
          expect((yield* create(actors.owner, malformed)).status, malformed).toBe(400);
        expect((yield* create(actors.owner, slug)).status).toBe(400);
        expect((yield* create(actors.owner, "executor")).status).toBe(400);
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/organization/delete", {
            organizationId: second.id,
          })).status,
        ).not.toBe(200);

        // Data is isolated in both directions.
        const post = (organization: string, name: string) =>
          api.request(actors.owner, "POST", `/api/organizations/${organization}/groups`, {
            name,
            description: "",
            memberIds: [],
          });
        expect((yield* post(actors.organization.id, `Only A ${suffix}`)).status).toBe(200);
        expect((yield* post(second.id, `Only B ${suffix}`)).status).toBe(200);
        const names = (organization: string) =>
          groups(actors.owner, organization).pipe(
            Effect.flatMap((response) => body(Groups, response)),
            Effect.map((view) => view.groups.map((group) => group.name)),
          );
        const inA = yield* names(actors.organization.id),
          inB = yield* names(second.id);
        expect(inA).toContain(`Only A ${suffix}`);
        expect(inA).not.toContain(`Only B ${suffix}`);
        expect(inB).toContain(`Only B ${suffix}`);
        expect(inB).not.toContain(`Only A ${suffix}`);
        // Membership of the setup organization grants nothing in the new one.
        expect((yield* groups(actors.admin, second.id)).status).toBeGreaterThanOrEqual(400);

        // A newcomer invited only to the second organization signs in and lands there.
        const email = `only-b-${suffix}@example.test`;
        const newcomer = yield* api.session();
        const joined = yield* api.request(newcomer, "POST", "/api/auth/self-host/register", {
          invitation: yield* invite(second.id, email),
          email,
          name: "Only B",
          password,
        });
        expect(joined.status).toBe(200);
        const returning = yield* api.session();
        expect(
          (yield* api.request(returning, "POST", "/api/auth/sign-in/email", { email, password }))
            .status,
        ).toBe(200);
        expect((yield* organizations(returning)).map((item) => item.slug)).toEqual([slug]);
        expect((yield* groups(returning, actors.organization.id)).status).toBeGreaterThanOrEqual(
          400,
        );
        yield* browser.login(returning);
        yield* browser.use("The root opens the only organization", (page) =>
          page.goto("/").then(() => page.waitForURL(`**/org/${slug}`)),
        );

        // An existing member of the setup organization accepts an invitation to the second one.
        const adminInvitation = yield* invite(second.id, "admin@example.test");
        yield* browser.login(actors.admin);
        yield* browser.use("Open the invitation", (page) =>
          page.goto(`/invite?invitation=${adminInvitation}`),
        );
        yield* browser.use("Accept the invitation", (page) =>
          page.getByRole("button", { name: "Accept invitation", exact: true }).click(),
        );
        yield* browser.use("The invited organization opens", (page) =>
          page.waitForURL(`**/org/${slug}`),
        );
        expect((yield* organizations(actors.admin)).map((item) => item.slug).sort()).toEqual(
          ["executor", slug].sort(),
        );
        expect((yield* groups(actors.admin, second.id)).status).toBe(200);
        expect((yield* groups(actors.admin, actors.organization.id)).status).toBe(200);
        yield* browser.use("Switch back to the setup organization", (page) =>
          page
            .getByRole("button", { name: /^Organization:/ })
            .click()
            .then(() =>
              page.getByRole("menuitemradio", { name: "Evidence lab", exact: true }).click(),
            )
            .then(() => page.waitForURL(`**/org/${actors.organization.slug}`)),
        );
        // Still not an owner: joining organizations grants no creation right.
        expect((yield* create(actors.admin, `refused2-${suffix}`)).status).toBe(403);
      }),
    ),
  );
});
