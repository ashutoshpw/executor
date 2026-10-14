/** Tool calls made by connected agents are counted per agent on the organization home page. */
import { expect, layer } from "@effect/vitest";
import { Duration, Effect, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App } from "../support/contracts.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { appsManifest } from "../support/apps-release.ts";

const source = `import { defineApp, query, object, string, router } from "apps";
export default defineApp({}, async () => ({ tools: router({
  echo: query({ input: object({ text: string() }), description: "Echo text back to the caller" },
    async (_ctx, { text }) => ({ text })),
  explode: query({ input: object({}), description: "Always fails" },
    async () => { throw new Error("exploded"); }),
}) }));`;

const Report = Schema.Struct({
  available: Schema.Boolean,
  scope: Schema.Literals(["organization", "self"]),
  totals: Schema.Struct({
    calls: Schema.Number,
    failures: Schema.Number,
    activeAgents: Schema.Number,
    activeApps: Schema.Number,
  }),
  topApps: Schema.Array(
    Schema.Struct({
      appId: Schema.String,
      appName: Schema.optional(Schema.String),
      calls: Schema.Number,
    }),
  ),
  agents: Schema.Array(
    Schema.Struct({
      agentKey: Schema.String,
      label: Schema.String,
      calls: Schema.Number,
      failures: Schema.Number,
    }),
  ),
});

/** Make personal access tokens for the given people, removed when the scenario ends. */
const accessToken = (session: Session, name: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(session, "POST", "/api/auth/api-key/create", { name }),
    );
    yield* Effect.addFinalizer(() =>
      api
        .request(session, "POST", "/api/auth/api-key/delete", { keyId: key.id })
        .pipe(Effect.orDie),
    );
    return key.key as Redacted.Redacted<string>;
  });

layer(HostedLive, { excludeTestServices: true })("Usage insights", (it) => {
  it.effect(scenarios.usageInsights.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          mcp = yield* McpClient;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Usage ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        // Members can call the app only once it is open to everyone.
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${prefix}/apps/${app.id}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const echo = `tools[${JSON.stringify(app.slug)}].echo`;
        const explode = `tools[${JSON.stringify(app.slug)}].explode`;

        // Each agent is its own token and client; the counts differ so they cannot be confused.
        const agents = [
          { name: "Alpha agent", session: actors.owner, successes: 3, failures: 1 },
          { name: "Beta agent", session: actors.owner, successes: 1, failures: 1 },
          { name: "Member agent", session: actors.member, successes: 2, failures: 0 },
        ];
        for (const agent of agents) {
          const token = yield* accessToken(agent.session, agent.name);
          const client = yield* mcp.connect(token, agent.name.toLowerCase().replaceAll(" ", "-"), {
            organization,
            clientName: agent.name,
          });
          const calls = [
            ...Array.from({ length: agent.successes }, (_, index) => ({
              path: echo,
              input: { text: `${agent.name} ${index}` },
            })),
            ...Array.from({ length: agent.failures }, () => ({ path: explode, input: {} })),
          ];
          for (const call of calls)
            yield* client.use(`${agent.name} calls ${call.path}`, (client, signal) =>
              client.callTool({ name: "call", arguments: { calls: call } }, undefined, { signal }),
            );
        }

        // Records are buffered before they are written, so read until they all arrive.
        const read = (session: Session, count: number) =>
          Effect.gen(function* () {
            const response = yield* api.request(session, "GET", `${prefix}/usage?range=7d`);
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const report = yield* body(Report, response);
            if (report.totals.calls !== count)
              return yield* Effect.fail(`Expected ${count} calls, saw ${report.totals.calls}`);
            return report;
          }).pipe(
            Effect.retry({
              schedule: Schedule.spaced(Duration.millis(500)),
              times: 20,
            }),
            Effect.orDie,
          );

        const report = yield* read(actors.owner, 8);
        expect(report).toMatchObject({
          available: true,
          scope: "organization",
          totals: { calls: 8, failures: 2, activeAgents: 3, activeApps: 1 },
        });
        expect(report.topApps).toHaveLength(1);
        expect(report.topApps[0]).toMatchObject({ appId: app.id, calls: 8 });
        const byLabel = new Map(report.agents.map((agent) => [agent.label, agent]));
        expect(byLabel.get("Alpha agent")).toMatchObject({ calls: 4, failures: 1 });
        expect(byLabel.get("Beta agent")).toMatchObject({ calls: 2, failures: 1 });
        expect(byLabel.get("Member agent")).toMatchObject({ calls: 2, failures: 0 });

        // A member sees only the calls their own agents made.
        const own = yield* read(actors.member, 2);
        expect(own).toMatchObject({
          scope: "self",
          totals: { calls: 2, failures: 0, activeAgents: 1 },
        });
        expect(own.agents.map((agent) => agent.label)).toEqual(["Member agent"]);

        // The home page shows the same numbers.
        yield* browser.login(actors.owner);
        yield* browser.use("Open the organization home page", (page) =>
          page.goto(`/org/${actors.organization.slug}`),
        );
        yield* browser.use("The tool call tile shows the total", (page) =>
          page
            .locator("dt", { hasText: "Tool calls" })
            .locator("xpath=following-sibling::dd[1]")
            .filter({ hasText: /^8$/ })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("The active agents tile shows three", (page) =>
          page
            .locator("dt", { hasText: "Active agents" })
            .locator("xpath=following-sibling::dd[1]")
            .filter({ hasText: /^3$/ })
            .waitFor({ state: "visible" }),
        );
        for (const [label, calls, failures] of [
          ["Alpha agent", "4", "1"],
          ["Beta agent", "2", "1"],
          ["Member agent", "2", "0"],
        ] as const)
          yield* browser.use(`The agents table lists ${label}`, (page) => {
            const row = page.getByRole("row").filter({ hasText: label });
            return Promise.all([
              row
                .getByRole("cell")
                .nth(0)
                .filter({ hasText: new RegExp(`^${calls}$`) })
                .waitFor({ state: "visible" }),
              row
                .getByRole("cell")
                .nth(1)
                .filter({ hasText: new RegExp(`^${failures}$`) })
                .waitFor({ state: "visible" }),
            ]);
          });
        yield* browser.checkpoint("Organization home page with usage");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
