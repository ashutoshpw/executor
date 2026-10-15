/** A self-host server keeps its own public app catalog, beside the upstream registry Add app also lists. */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomUUID } from "node:crypto";
import { Api, SessionClients, body, type Session } from "../support/api.ts";
import { password } from "../support/actors.ts";
import { TestLive, withCase } from "../support/case.ts";
import { App, Organization, Resource } from "../support/contracts.ts";
import { withApps } from "../support/apps-release.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import { registryPublication, registryUpstream } from "../support/registry-upstream.ts";
import { scenarios } from "../test-plan.ts";

const Workspace = Schema.Struct({ revision: Schema.Struct({ commit: Schema.String }) });
const Publication = Schema.Struct({ name: Schema.String, commit: Schema.String });
const Failure = Schema.Struct({
  _tag: Schema.String,
  reason: Schema.String,
  status: Schema.optional(Schema.Number),
});
const Authoring = Schema.Struct({
  canPublish: Schema.Boolean,
  namespace: Schema.NullOr(Schema.String),
});
/** Compared whole, so a changed readiness shape fails here. */
const Readiness = Schema.Struct({ publication: Schema.Unknown });
const Copy = Schema.Struct({
  id: Schema.String,
  copiedFrom: Schema.NullOr(Schema.Struct({ reference: Schema.String, name: Schema.String })),
});
const Snapshot = Schema.Struct({ publication: Publication });

/** One fresh server, its owner and organization, and a client that reaches only that server. */
const freshServer = (environment: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const origin = yield* startFreshSelfHost(target, environment);
    const api = yield* Api.pipe(
      Effect.provide(Layer.fresh(Api.layer)),
      Effect.provide(Layer.fresh(SessionClients.layer)),
      Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
    );
    const owner = yield* api.session();
    const setup = yield* api.request(owner, "POST", "/api/auth/self-host/setup", {
      name: "Publishing Owner",
      email: "publishing-owner@example.test",
      password,
      organizationName: "Publishing lab",
    });
    expect(setup.status, JSON.stringify(setup.body)).toBe(200);
    const [organization] = yield* body(
      Schema.NonEmptyArray(Organization),
      yield* api.request(owner, "GET", "/api/auth/organization/list"),
    );
    /** Deploy an app whose package.json carries `name`, and return it with its commit. */
    const deploy = (organizationId: string, name: string, marker: string) =>
      Effect.gen(function* () {
        const prefix = `/api/organizations/${organizationId}`;
        const deployed = yield* api.request(owner, "POST", `${prefix}/apps/deploy`, {
          name: `Published ${marker}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp } from "apps";\n// ${marker}\nexport default defineApp({}, {});\n`,
            },
            {
              path: "package.json",
              content: JSON.stringify({ name, description: marker, dependencies: withApps() }),
            },
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const working = yield* api.request(owner, "GET", `${prefix}/apps/${app.id}/workspace`);
        expect(working.status, JSON.stringify(working.body)).toBe(200);
        return { app, commit: (yield* body(Workspace, working)).revision.commit };
      });
    const publish = (session: Session, organizationId: string, app: string, commit: string) =>
      api.request(session, "POST", `/api/organizations/${organizationId}/apps/${app}/publication`, {
        commit,
      });
    const unpublish = (session: Session, organizationId: string, name: string) =>
      api.request(
        session,
        "POST",
        `/api/organizations/${organizationId}/app-publications/unpublish`,
        {
          package: name,
        },
      );
    const catalog = (organizationId: string, name?: string) =>
      api.request(
        owner,
        "GET",
        `/api/organizations/${organizationId}/app-publications${name === undefined ? "" : `?name=${encodeURIComponent(name)}`}`,
      );
    const readiness = (organizationId: string, app: string) =>
      api
        .request(owner, "GET", `/api/organizations/${organizationId}/apps/${app}/workspace/display`)
        .pipe(Effect.flatMap((response) => body(Readiness, response)));
    /** A request with no credentials, as another server or the CLI makes it. */
    const anonymous = (path: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.execute(HttpClientRequest.get(new URL(path, origin)));
          return {
            status: response.status,
            headers: response.headers,
            json: yield* response.json,
          };
        }),
      ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
    return {
      api,
      owner,
      origin,
      organization,
      deploy,
      publish,
      unpublish,
      catalog,
      readiness,
      anonymous,
    };
  });

layer(TestLive, { excludeTestServices: true })("Self-host publishing", (it) => {
  it.effect(
    scenarios.selfHostPublishing.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const registry = yield* registryUpstream;
          const server = yield* freshServer({ EXECUTOR_REGISTRY_URL: registry.origin });
          const { api, owner, origin, organization } = server;
          const suffix = randomUUID().slice(0, 8);
          const prefix = `/api/organizations/${organization.id}`;
          const name = `@${organization.slug}.executor.community/notes-${suffix}`;

          // A plain member and a second organization.
          const invitation = yield* api.request(
            owner,
            "POST",
            "/api/auth/organization/invite-member",
            {
              organizationId: organization.id,
              email: "publishing-member@example.test",
              role: "member",
            },
          );
          expect(invitation.status, JSON.stringify(invitation.body)).toBe(200);
          const member = yield* api.session();
          expect(
            (yield* api.request(member, "POST", "/api/auth/self-host/register", {
              invitation: (yield* body(Resource, invitation)).id,
              email: "publishing-member@example.test",
              name: "Publishing Member",
              password,
            })).status,
          ).toBe(200);
          const otherSlug = `installer-${suffix}`;
          const created = yield* api.request(owner, "POST", "/api/auth/organization/create", {
            name: "Installers",
            slug: otherSlug,
            keepCurrentActiveOrganization: true,
          });
          expect(created.status, JSON.stringify(created.body)).toBe(200);
          const other = yield* body(Organization, created);
          // An administrator of the second organization who belongs to no other.
          const adminInvitation = yield* api.request(
            owner,
            "POST",
            "/api/auth/organization/invite-member",
            { organizationId: other.id, email: "installer-admin@example.test", role: "admin" },
          );
          expect(adminInvitation.status, JSON.stringify(adminInvitation.body)).toBe(200);
          const outsider = yield* api.session();
          expect(
            (yield* api.request(outsider, "POST", "/api/auth/self-host/register", {
              invitation: (yield* body(Resource, adminInvitation)).id,
              email: "installer-admin@example.test",
              name: "Installer Admin",
              password,
            })).status,
          ).toBe(200);

          // The owner may publish, and the name sits under the organization's slug on the domain.
          const original = yield* server.deploy(organization.id, name, `first ${suffix}`);
          const authoring = yield* body(
            Authoring,
            yield* api.request(owner, "GET", `${prefix}/apps/${original.app.id}/authoring`),
          );
          expect(authoring).toEqual({
            canPublish: true,
            namespace: `${organization.slug}.executor.community`,
          });
          expect((yield* server.readiness(organization.id, original.app.id)).publication).toEqual({
            status: "ready",
            manifest: { name, description: `first ${suffix}` },
          });

          // A name the upstream already lists is not this server's to publish, and the repair keeps
          // the label. Another label in the same scope publishes below.
          const taken = `@${organization.slug}.executor.community/taken-${suffix}`;
          yield* registry.list({ ...registryPublication, name: taken, commit: "c".repeat(40) });
          const shadow = yield* server.deploy(organization.id, taken, `shadow ${suffix}`);
          expect(
            (yield* server.readiness(organization.id, shadow.app.id)).publication,
          ).toMatchObject({
            status: "blocked",
            issue: { reason: "name-taken", name: taken },
            suggestedName: expect.stringContaining(`@${organization.slug}.executor.community/`),
          });
          const shadowed = yield* server.publish(
            owner,
            organization.id,
            shadow.app.id,
            shadow.commit,
          );
          expect(shadowed.status, JSON.stringify(shadowed.body)).toBe(400);
          expect(yield* body(Failure, shadowed)).toMatchObject({
            _tag: "RegistryError",
            reason: "conflict",
          });

          // An administrator of another organization cannot publish in this one's scope, through
          // either organization's routes.
          const foreign = yield* server.deploy(
            other.id,
            `@${organization.slug}.executor.community/foreign-${suffix}`,
            `foreign ${suffix}`,
          );
          const wrongScope = yield* api.request(
            outsider,
            "POST",
            `/api/organizations/${other.id}/apps/${foreign.app.id}/publication`,
            { commit: foreign.commit },
          );
          expect(wrongScope.status, JSON.stringify(wrongScope.body)).toBe(400);
          expect(yield* body(Failure, wrongScope)).toMatchObject({
            _tag: "RegistryError",
            reason: "forbidden",
          });
          const wrongOrganization = yield* server.publish(
            outsider,
            organization.id,
            original.app.id,
            original.commit,
          );
          expect(wrongOrganization.status, JSON.stringify(wrongOrganization.body)).toBe(403);

          // A member is refused every publishing operation, whatever the interface shows.
          for (const refused of [
            yield* server.publish(member, organization.id, original.app.id, original.commit),
            yield* api.request(member, "GET", `${prefix}/app-publications/published`),
            yield* server.unpublish(member, organization.id, name),
          ])
            expect(refused.status, JSON.stringify(refused.body)).toBe(403);

          // The owner publishes; the server's public catalog lists it without credentials.
          const published = yield* server.publish(
            owner,
            organization.id,
            original.app.id,
            original.commit,
          );
          expect(published.status, JSON.stringify(published.body)).toBe(200);
          expect(yield* body(Publication, published)).toEqual({ name, commit: original.commit });
          const listing = yield* server.anonymous("/api/registry/apps");
          expect(listing.status).toBe(200);
          expect(listing.headers["access-control-allow-origin"]).toBe("*");
          // Only what is published here: the upstream listing is not mirrored.
          expect(listing.json).toMatchObject([{ name, commit: original.commit }]);
          expect(JSON.stringify(listing.json)).not.toContain(registryPublication.name);
          const source = yield* server.anonymous(
            `/api/registry/source?name=${encodeURIComponent(name)}&commit=${original.commit}`,
          );
          expect(source.status).toBe(200);
          expect(Schema.decodeUnknownSync(Snapshot)(source.json).publication.name).toBe(name);
          const mirrored = yield* server.anonymous(
            `/api/registry/source?name=${encodeURIComponent(registryPublication.name)}&commit=${registryPublication.commit}`,
          );
          expect(mirrored.json, "the upstream source is not served from here").toMatchObject({
            _tag: "RegistryError",
            reason: "not-found",
          });

          // The upstream later publishes the same name: this server's listing still wins in the
          // catalog, which shows the name once.
          yield* registry.list({ ...registryPublication, name, commit: "b".repeat(40) });
          // The upstream's full listing is cached for minutes once read, so the outage below only
          // shows through if nothing has read it yet. Only named reads have reached it so far.
          expect(
            (yield* registry.paths).filter((path) => path === "/api/registry/apps"),
            "no full upstream listing was read before the outage",
          ).toEqual([]);
          // The authenticated catalog keeps listing this server's apps when the upstream is down.
          yield* registry.outage(true);
          const degraded = yield* server.catalog(other.id);
          expect(degraded.status, JSON.stringify(degraded.body)).toBe(200);
          expect(degraded.body).toMatchObject([{ name }]);
          expect(degraded.body).toHaveLength(1);
          // Asking for the upstream's own name still reports its failure.
          const named = yield* server.catalog(other.id, registryPublication.name);
          expect(named.status).toBe(400);
          expect(yield* body(Failure, named)).toEqual({
            _tag: "RegistryError",
            reason: "status",
            status: 503,
          });
          // Once it is back, the full catalog lists both, sorted by name.
          yield* registry.outage(false);
          const both = yield* server.catalog(other.id);
          expect(both.status, JSON.stringify(both.body)).toBe(200);
          const entries = yield* body(Schema.Array(Publication), both);
          expect(entries.map((entry) => entry.name)).toEqual(
            [registryPublication.name, taken, name].sort(),
          );
          expect(entries.find((entry) => entry.name === name)?.commit).toBe(original.commit);

          // Another organization installs the local listing; the copy points back at this server.
          const installed = yield* api.request(
            owner,
            "POST",
            `/api/organizations/${other.id}/apps/copies`,
            {
              from: { package: name, commit: original.commit },
              name: `Installed ${suffix}`,
            },
          );
          expect(installed.status, JSON.stringify(installed.body)).toBe(200);
          const copy = yield* body(Copy, installed);
          expect(copy.copiedFrom?.name).toBe(name);
          const local = new URL(copy.copiedFrom?.reference ?? "");
          expect(local.origin).toBe(new URL(origin).origin);
          expect(local.pathname).toBe("/api/registry/source");

          // An upstream listing installs too, and its copy points at the upstream.
          const external = yield* api.request(
            owner,
            "POST",
            `/api/organizations/${other.id}/apps/copies`,
            {
              from: { package: registryPublication.name, commit: registryPublication.commit },
              name: `Upstream ${suffix}`,
            },
          );
          expect(external.status, JSON.stringify(external.body)).toBe(200);
          const upstreamCopy = yield* body(Copy, external);
          expect(new URL(upstreamCopy.copiedFrom?.reference ?? "").origin).toBe(registry.origin);

          // Unpublishing removes the listing and leaves the installed copy alone.
          const removed = yield* server.unpublish(owner, organization.id, name);
          expect(removed.status, JSON.stringify(removed.body)).toBe(200);
          expect((yield* server.anonymous("/api/registry/apps")).json).toEqual([]);
          const remaining = yield* api.request(
            owner,
            "GET",
            `/api/organizations/${other.id}/apps/${copy.id}`,
          );
          expect(remaining.status, JSON.stringify(remaining.body)).toBe(200);
        }),
      ),
    { timeout: 240_000 },
  );

  it.effect(
    scenarios.selfHostPublishingDomain.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const registry = yield* registryUpstream;
          const environment = { EXECUTOR_REGISTRY_URL: registry.origin };
          const server = yield* freshServer({
            ...environment,
            EXECUTOR_PUBLISHING_DOMAIN: "apps.test",
          });
          const { api, owner, organization } = server;
          const scope = `${organization.slug}.apps.test`;
          const name = `@${scope}/domain-${randomUUID().slice(0, 8)}`;

          // The scope in the dashboard's authoring controls, the API and the readiness check.
          const first = yield* server.deploy(organization.id, name, "configured domain");
          const authoring = yield* body(
            Authoring,
            yield* api.request(
              owner,
              "GET",
              `/api/organizations/${organization.id}/apps/${first.app.id}/authoring`,
            ),
          );
          expect(authoring).toEqual({ canPublish: true, namespace: scope });
          const published = yield* server.publish(
            owner,
            organization.id,
            first.app.id,
            first.commit,
          );
          expect(published.status, JSON.stringify(published.body)).toBe(200);
          expect(yield* body(Publication, published)).toEqual({ name, commit: first.commit });
          expect((yield* server.anonymous("/api/registry/apps")).json).toMatchObject([{ name }]);

          // A name on the default domain is not this server's scope, and the repair offers its own.
          const label = `foreign-${randomUUID().slice(0, 8)}`;
          const foreign = `@${organization.slug}.executor.community/${label}`;
          const other = yield* server.deploy(organization.id, foreign, "default domain");
          expect((yield* server.readiness(organization.id, other.app.id)).publication).toEqual({
            status: "blocked",
            issue: { _tag: "PublicationIssue", reason: "forbidden-scope", name: foreign },
            suggestedName: `@${scope}/${label}`,
          });

          // A value that is not a domain stops the server rather than naming every package wrongly.
          const refused = yield* Effect.exit(
            startFreshSelfHost(yield* Target, {
              ...environment,
              EXECUTOR_PUBLISHING_DOMAIN: "Not_A_Domain",
            }),
          );
          expect(Exit.isFailure(refused), "an invalid publishing domain starts no server").toBe(
            true,
          );
          // The server says why in its own output, which the failure carries.
          expect(JSON.stringify(refused)).toContain("EXECUTOR_PUBLISHING_DOMAIN must be");
        }),
      ),
    { timeout: 240_000 },
  );
});
