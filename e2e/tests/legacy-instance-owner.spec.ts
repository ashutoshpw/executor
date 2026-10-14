/**
 * Instances set up before organizations could be added have no record of who owns the instance.
 * Upgrading records the owner of the oldest organization, so that person alone can create
 * organizations afterwards. A second start finds the record and changes nothing.
 */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withHostedCase } from "../support/case.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const instance = {
  sql: `SELECT u.email, i."primaryOrganizationId" AS organization
    FROM "selfHostInstance" i JOIN "user" u ON u.id = i."ownerUserId"`,
};
const journal = {
  sql: `SELECT count(*)::int AS runs FROM private_self_host_migrations
    WHERE migration_id = 1 AND name = 'instance_owner'`,
};

layer(TestLive, { excludeTestServices: true })("Legacy instance owner", (it) => {
  it.effect(scenarios.legacyInstanceOwner.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const create = (session: typeof actors.owner) =>
          api.request(session, "POST", "/api/auth/organization/create", {
            name: "Upgraded",
            slug: `upgraded-${randomUUID().slice(0, 8)}`,
            keepCurrentActiveOrganization: true,
          });
        // An older version left organizations and members but no instance record.
        yield* legacyStorage([
          { sql: `DELETE FROM "selfHostInstance"` },
          { sql: `DELETE FROM private_self_host_migrations WHERE migration_id = 1` },
        ]);
        yield* serverControl("start");

        const expected = [
          [{ email: "owner@example.test", organization: actors.organization.id }],
          [{ runs: 1 }],
        ];
        // Reading stored rows stops the product, as writing them does.
        expect(yield* legacyStorage([instance, journal])).toEqual(expected);
        yield* serverControl("start");
        // The upgraded owner creates organizations in the interface; nobody else does.
        expect((yield* create(actors.admin)).status).toBe(403);
        expect((yield* create(actors.member)).status).toBe(403);
        yield* browser.login(actors.owner);
        yield* browser.use("Open the switcher as the upgraded owner", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/apps`)
            .then(() => page.getByRole("button", { name: /^Organization:/ }).click()),
        );
        yield* browser.use("The creation entry is offered", (page) =>
          page.getByRole("menuitem", { name: "Create organization", exact: true }).waitFor(),
        );
        expect((yield* create(actors.owner)).status).toBe(200);

        // Starting again records nothing twice, and a new organization does not move the owner.
        yield* serverControl("start");
        expect(yield* legacyStorage([instance, journal])).toEqual(expected);
        yield* serverControl("start");
      }),
    ),
  );
});
