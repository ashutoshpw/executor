/** Tool calls made by connected agents, schedules and workflows are counted per agent on the organization home page. */
import { expect, layer } from "@effect/vitest";
import { Clock, Duration, Effect, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { scenarios } from "../test-plan.ts";
import { Api, body, type Session } from "../support/api.ts";
import { Actors, password } from "../support/actors.ts";
import { App, Resource } from "../support/contracts.ts";
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

/** A member's schedule and a workflow that each call the app's own tools, one of them failing. */
const automationSource = `import { defineApp, query, mutation, workflow, userInterval, object, router,
  type WorkflowContext } from "apps";
import { always } from "apps/operations/approval";
const ping = mutation({ input: object({}) }, async () => "pong");
const look = query({ input: object({}) }, async () => "look");
const boom = mutation({ input: object({}) }, async () => { throw new Error("boom"); });
const guarded = mutation({ input: object({}), approval: always() }, async () => "guarded");
const relay = workflow({ input: object({}) }, async (ctx: WorkflowContext<{}>) => {
  await ctx.step.runMutation("first", ping, {});
  await ctx.step.runQuery("second", look, {});
  return null;
});
const gated = workflow({ input: object({}) }, async (ctx: WorkflowContext<{}>) =>
  ctx.step.runMutation("waiting", guarded, {}, { retries: { limit: 0, delay: 0 } }));
const breaks = workflow({ input: object({}) }, async (ctx: WorkflowContext<{}>) =>
  ctx.step.runMutation("failing", boom, {}, { retries: { limit: 0, delay: 0 } }));
export default defineApp({}, async () => ({
  tools: router({ ping, look, boom, guarded }),
  workflows: { relay, breaks, gated },
  schedules: { heartbeat: userInterval({ minutes: 1 }, ping, {}) },
}));`;

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
  failureTypes: Schema.Array(Schema.Struct({ errorType: Schema.String, count: Schema.Number })),
});
const Run = Schema.Struct({ id: Schema.String, status: Schema.String });

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
  it.effect(scenarios.usageInsightsAutomation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Automation ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: automationSource }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);

        const finished = (session: Session, run: string) =>
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + 30_000;
            for (;;) {
              const read = yield* api.request(session, "GET", `${path}/workflow-runs/${run}`);
              const state = yield* body(Run, read);
              if (state.status === "complete" || state.status === "errored") return state.status;
              expect(yield* Clock.currentTimeMillis, JSON.stringify(state)).toBeLessThan(deadline);
              yield* Effect.sleep("100 millis");
            }
          });
        const workflowRun = (session: Session, workflow: string) =>
          Effect.gen(function* () {
            const started = yield* api.request(session, "POST", `${path}/workflow-runs`, {
              workflow,
              input: {},
            });
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            return yield* finished(session, (yield* body(Resource, started)).id);
          });

        // The member's schedule runs twice, and the member and the owner each run the workflow,
        // which calls two tools; the owner also runs one that fails.
        const copy = yield* body(
          Schema.Struct({ id: Schema.String }),
          yield* api.request(actors.member, "PATCH", `${path}/schedules/heartbeat`, {
            enabled: true,
          }),
        );
        for (const turn of [1, 2]) {
          expect(
            (yield* api.request(actors.member, "POST", `${path}/schedules/heartbeat/run`)).status,
          ).toBe(200);
          yield* Effect.gen(function* () {
            const runs = yield* body(
              Schema.Array(Schema.Struct({ status: Schema.String })),
              yield* api.request(actors.owner, "GET", `${prefix}/scheduled-runs?app=${app.id}`),
            );
            if (runs.filter((run) => run.status === "succeeded").length < turn)
              return yield* Effect.fail(`Run ${turn} has not succeeded`);
          }).pipe(
            Effect.retry({ schedule: Schedule.spaced(Duration.millis(200)), times: 100 }),
            Effect.orDie,
          );
        }
        // Pause it so no occurrence adds a call while the numbers are read.
        expect(
          (yield* api.request(actors.member, "PATCH", `${path}/schedules/heartbeat`, {
            enabled: false,
          })).status,
        ).toBe(200);
        expect(yield* workflowRun(actors.member, "relay")).toBe("complete");
        expect(yield* workflowRun(actors.owner, "relay")).toBe("complete");
        expect(yield* workflowRun(actors.owner, "breaks")).toBe("errored");
        // A step held for approval never ran the tool, so it is neither a call nor a failure.
        yield* workflowRun(actors.owner, "gated");

        const read = (session: Session, count: number) =>
          Effect.gen(function* () {
            const response = yield* api.request(session, "GET", `${prefix}/usage?range=7d`);
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const report = yield* body(Report, response);
            if (report.totals.calls !== count)
              return yield* Effect.fail(`Expected ${count} calls, saw ${report.totals.calls}`);
            return report;
          }).pipe(
            Effect.retry({ schedule: Schedule.spaced(Duration.millis(500)), times: 30 }),
            Effect.orDie,
          );
        const scheduleKey = `schedule:${copy.id}`;
        const workflowKey = (name: string) => `workflow:${app.id}/${name}`;

        // Administrators see every schedule and workflow, named as the app declares them.
        const all = yield* read(actors.owner, 7);
        expect(all).toMatchObject({ scope: "organization", totals: { calls: 7, failures: 1 } });
        const agents = new Map(all.agents.map((agent) => [agent.agentKey, agent]));
        expect(agents.get(scheduleKey)).toMatchObject({
          label: "heartbeat",
          calls: 2,
          failures: 0,
        });
        expect(agents.get(workflowKey("relay"))).toMatchObject({
          label: "relay",
          calls: 4,
          failures: 0,
        });
        expect(agents.get(workflowKey("breaks"))).toMatchObject({
          label: "breaks",
          calls: 1,
          failures: 1,
        });
        expect(agents.has(workflowKey("gated"))).toBe(false);
        expect(all.failureTypes).toHaveLength(1);
        expect(all.topApps[0]).toMatchObject({ appId: app.id, calls: 7 });

        // A member sees only what runs for them: their schedule copy and their own workflow run.
        const own = yield* read(actors.member, 4);
        expect(own).toMatchObject({ scope: "self", totals: { calls: 4, failures: 0 } });
        expect(new Map(own.agents.map((agent) => [agent.agentKey, agent.calls]))).toEqual(
          new Map([
            [scheduleKey, 2],
            [workflowKey("relay"), 2],
          ]),
        );

        // The home page lists them like any other agent.
        yield* browser.login(actors.owner);
        yield* browser.use("Open the organization home page", (page) =>
          page.goto(`/org/${actors.organization.slug}`),
        );
        for (const [label, calls, failures] of [
          ["heartbeat", "2", "0"],
          ["relay", "4", "0"],
          ["breaks", "1", "1"],
        ] as const)
          yield* browser.use(`The agents table lists the ${label} automation`, (page) => {
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
        yield* browser.checkpoint("Home page with schedule and workflow agents");
      }),
    ),
  );
  it.effect(scenarios.usageInsightsRange.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser;
        const home = `/org/${actors.organization.slug}`;
        const pressed = (label: string) => (page: Page) =>
          page
            .getByRole("group", { name: "Time range" })
            .getByRole("button", { name: label, pressed: true })
            .waitFor({ state: "visible" });
        yield* browser.login(actors.owner);

        yield* browser.use("Home defaults to seven days with a clean address", (page) =>
          page
            .goto(home)
            .then(() => pressed("7 days")(page))
            .then(() => expect(new URL(page.url()).search).toBe("")),
        );
        yield* browser.use("Choosing a range puts it in the address", (page) =>
          page
            .getByRole("button", { name: "30 days" })
            .click()
            .then(() => page.waitForURL(`**${home}?range=30d`))
            .then(() => pressed("30 days")(page)),
        );
        yield* browser.use("Reload keeps the range", (page) =>
          page
            .reload()
            .then(() => pressed("30 days")(page))
            .then(() => expect(new URL(page.url()).searchParams.get("range")).toBe("30d")),
        );
        yield* browser.use("A shared address opens its range", (page) =>
          page.goto(`${home}?range=24h`).then(() => pressed("24 hours")(page)),
        );
        yield* browser.use("Going back from another page restores the range", (page) =>
          page
            .getByRole("link", { name: "Apps", exact: true })
            .first()
            .click()
            .then(() => page.waitForURL(`**${home}/apps`))
            .then(() => page.goBack())
            .then(() => page.waitForURL(`**${home}?range=24h`))
            .then(() => pressed("24 hours")(page)),
        );
        yield* browser.use("Choosing the default range clears it", (page) =>
          page
            .getByRole("button", { name: "7 days" })
            .click()
            .then(() => pressed("7 days")(page))
            .then(() => page.waitForFunction(() => new URL(location.href).search === "")),
        );
        yield* browser.use("An unknown range falls back to the default", (page) =>
          page.goto(`${home}?range=forever`).then(() => pressed("7 days")(page)),
        );

        // Entering the product lands on Home, not Apps.
        yield* browser.use("The signed-in root opens Home", (page) =>
          page
            .goto("/")
            .then(() => page.waitForURL(`**${home}`))
            .then(() => pressed("7 days")(page)),
        );

        const signIn = (title: string, entry: string, landing: string) =>
          Effect.gen(function* () {
            yield* browser.use(`${title}: start signed out`, (page) =>
              page
                .context()
                .clearCookies()
                .then(() => page.goto(entry)),
            );
            yield* browser.use(`${title}: enter the owner email`, (page) =>
              page.getByLabel("Email", { exact: true }).fill("owner@example.test"),
            );
            yield* browser.use(`${title}: enter the password`, (page) =>
              page.getByLabel("Password", { exact: true }).fill(password),
            );
            yield* browser.use(`${title}: sign in`, (page) =>
              page.getByRole("button", { name: "Sign in", exact: true }).click(),
            );
            yield* browser.use(`${title}: lands on ${landing}`, (page) =>
              page.waitForURL(`**${landing}`),
            );
          });
        // Signing in lands on Home, and an explicit redirect target still wins.
        yield* signIn("Sign-in", "/login", home);
        yield* browser.use("Home opens after sign-in", pressed("7 days"));
        yield* signIn(
          "Sign-in with a redirect",
          `/login?redirect=${encodeURIComponent(`${home}/apps`)}`,
          `${home}/apps`,
        );
      }),
    ),
  );
});
