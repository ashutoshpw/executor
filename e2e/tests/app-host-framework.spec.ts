/**
 * The self-host product serves the `apps` framework it was built with. An app that pins this
 * checkout's version builds from the host's own files even when the registry does not hold that
 * version, and it runs on the host's newest protocol. An app pinned to a published release still
 * installs that release from the registry, and an operator can turn the host's own framework off.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsVersion } from "../support/apps-release.ts";
import { publishedOnlyNpmRegistry } from "../support/npm-registry.ts";
import { serverControl } from "../support/server-control.ts";

/** The last release npm holds before this checkout's, speaking protocol 13 without `ctx.blobs`. */
const published = "0.0.1-beta.91";

/** Reports whether the framework gives the app `ctx.blobs`, and what the host stores through it. */
const files = (version: string) => [
  { path: "package.json", content: JSON.stringify({ dependencies: { apps: version } }) },
  {
    path: "index.ts",
    content: `import { defineApp, query, object, router } from "apps";
export default defineApp({}, async ctx => ({
  tools: router({
    framework: query({ input: object({}) }, async () =>
      ctx.blobs === undefined ? { blobs: "absent" } : { blobs: (await ctx.blobs.limits()).methods }),
  }),
}));`,
  },
];
const Framework = Schema.Struct({
  blobs: Schema.Union([Schema.Literal("absent"), Schema.Array(Schema.String)]),
});

layer(HostedLive, { excludeTestServices: true })("Host framework", (it) => {
  it.effect(scenarios.appHostFramework.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        // Builds install from a registry that holds the published releases but not this
        // checkout's version, as npm does until the version is published.
        const registry = yield* publishedOnlyNpmRegistry;
        yield* serverControl("stop");
        yield* serverControl("environment", 200, { EXECUTOR_NPM_REGISTRY: registry.url });
        yield* serverControl("start");

        const deploy = (version: string) =>
          api.request(actors.owner, "POST", `${prefix}/deploy`, {
            name: `Framework ${randomUUID().slice(0, 8)}`,
            files: files(version),
          });
        const framework = (id: string) =>
          api
            .request(actors.owner, "POST", `${prefix}/${id}/tools/call`, {
              tool: "framework",
              kind: "query",
              input: {},
            })
            .pipe(Effect.flatMap((response) => body(Framework, response)));
        const deployed = (version: string) =>
          Effect.gen(function* () {
            const response = yield* deploy(version);
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
            );
            return app;
          });

        // The checkout's version is not in the registry, so only the host's files can build it.
        expect(registry.version).toBe(appsVersion);
        const own = yield* deployed(appsVersion);
        const current = yield* framework(own.id);
        expect(current.blobs).toContain("fromUrl");
        // An app pinned to a published release installs that release from the registry.
        const older = yield* deployed(published);
        expect(yield* framework(older.id)).toEqual({ blobs: "absent" });

        // Turning the host's framework off leaves the registry as the only source.
        yield* serverControl("stop");
        yield* serverControl("environment", 200, { EXECUTOR_APPS_FRAMEWORK_DISABLED: "true" });
        yield* serverControl("start");
        const refused = yield* deploy(appsVersion);
        expect(refused.status).toBe(422);
        expect(refused.body).toMatchObject({ _tag: "DeploymentBuildFailed" });
        yield* deployed(published);
        // The retained build of the app that used the host's files keeps running.
        expect(yield* framework(own.id)).toEqual(current);
      }),
    ),
  );
});
