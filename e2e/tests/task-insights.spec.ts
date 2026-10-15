/** Tool calls an agent makes for one task are listed together, in order, for organization admins. */
import { expect, layer } from "@effect/vitest";
import { Duration, Effect, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, SessionClients, body, type Session } from "../support/api.ts";
import { Actors, password } from "../support/actors.ts";
import { App, Organization, Resource } from "../support/contracts.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { appsManifest } from "../support/apps-release.ts";

/** A 1x1 PNG. */
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const source = `import { defineApp, query, mutation, object, string, array, record, router } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, async (ctx) => ({ tools: router({
  echo: query({ input: object({ text: string() }), description: "Echo text back to the caller" },
    async (_ctx, { text }) => ({ text })),
  explode: query({ input: object({}), description: "Always fails" },
    async () => { throw new Error("exploded"); }),
  approved: mutation({
    input: object({ text: string() }),
    description: "Echo text back after the caller approves",
    approval: always(),
  }, async (_ctx, { text }) => ({ text })),
  secretive: query({ input: object({}), description: "Return a credential and a plain value" },
    async () => ({ apiKey: "resp-key-123", region: "eu", note: "kept" })),
  picture: query({ input: object({}), description: "Return an MCP style image block" },
    async () => ({ content: [{ type: "image", data: ${JSON.stringify(png)}, mimeType: "image/png" }] })),
  inline: query({ input: object({}), description: "Return a data URI image" },
    async () => ({ preview: "data:image/png;base64,${png}" })),
  huge: query({ input: object({}), description: "Return a very long string" },
    async () => ({ text: "y".repeat(40000) })),
  stored: query({ input: object({}), description: "Return a stored file handle" },
    async () => ({ handle: await ctx.blobs.create(new TextEncoder().encode("hello file"), { contentType: "text/plain" }) })),
  sink: query({
    input: object({
      text: string(),
      password: string().optional(),
      note: string().optional(),
      label: string().optional(),
      ssn: string().optional(),
      big: string().optional(),
      endpoint: string().optional(),
      headers: array(object({ name: string(), value: string() })).optional(),
      config: record(string()).optional(),
      items: array(object({ token: string().optional(), name: string().optional() })).optional(),
    }),
    description: "Accept anything and say nothing",
  }, async () => ({ ok: true })),
}) }));`;

const TaskList = Schema.Struct({
  available: Schema.Boolean,
  tasks: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      kind: Schema.Literals(["task", "session", "run"]),
      label: Schema.String,
      calls: Schema.Number,
      failures: Schema.Number,
      apps: Schema.Array(
        Schema.Struct({ appId: Schema.String, appName: Schema.optional(Schema.String) }),
      ),
    }),
  ),
  next: Schema.NullOr(Schema.String),
});
const TaskCall = Schema.Struct({
  at: Schema.String,
  appId: Schema.String,
  appName: Schema.optional(Schema.String),
  toolName: Schema.String,
  outcome: Schema.Literals(["success", "failure", "cancelled"]),
  errorType: Schema.NullOr(Schema.String),
  durationMs: Schema.Number,
  sessionId: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.String),
  arguments: Schema.NullOr(Schema.String),
  response: Schema.NullOr(Schema.String),
  files: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      uri: Schema.String,
      contentType: Schema.NullOr(Schema.String),
      size: Schema.NullOr(Schema.Number),
      available: Schema.Boolean,
    }),
  ),
});
const TaskDetail = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["task", "session", "run"]),
  label: Schema.String,
  calls: Schema.Array(TaskCall),
  truncated: Schema.Boolean,
});
const Settings = Schema.Struct({
  recordArguments: Schema.Boolean,
  recordResponses: Schema.Boolean,
  retentionDays: Schema.Number,
  extraMaskedKeys: Schema.Array(Schema.String),
  available: Schema.Boolean,
});
/** What a tools/call result carries in its `_meta`. */
const ResultMeta = Schema.Struct({
  _meta: Schema.Struct({
    "executor/runId": Schema.String,
    "executor/taskId": Schema.optionalKey(Schema.String),
  }),
});
const resultMeta = (result: unknown) => Schema.decodeUnknownSync(ResultMeta)(result)._meta;

interface CallParams {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
}

const taskIdKey = "executor/taskId";

/** Deploy the scenario's app, open to everyone so members can call it, and remove it afterwards. */
const deployApp = Effect.gen(function* () {
  const api = yield* Api;
  const actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
    name: `Tasks ${randomUUID().slice(0, 8)}`,
    files: [{ path: "index.ts", content: source }, appsManifest],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed);
  yield* Effect.addFinalizer(() =>
    api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
  );
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
  return app;
});

/** An MCP client with its own personal access token, removed when the scenario ends. */
const connectAgent = (session: Session, name: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const actors = yield* Actors;
    const mcp = yield* McpClient;
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(session, "POST", "/api/auth/api-key/create", { name }),
    );
    yield* Effect.addFinalizer(() =>
      api
        .request(session, "POST", "/api/auth/api-key/delete", { keyId: key.id })
        .pipe(Effect.orDie),
    );
    const client = yield* mcp.connect(
      key.key as Redacted.Redacted<string>,
      name.replaceAll(" ", "-"),
      {
        organization: actors.organization.id,
        clientName: name,
      },
    );
    return {
      call: (operation: string, params: CallParams) =>
        client.use(operation, (client, signal) => client.callTool(params, undefined, { signal })),
    };
  });

/** The task list and detail routes, read until `ready` holds because records are buffered. */
const taskReader = (organization: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const prefix = `/api/organizations/${organization}`;
    const retry = Effect.retry({
      schedule: Schedule.spaced(Duration.millis(500)),
      times: 20,
    });
    return {
      detail: (session: Session, taskId: string, ready: (calls: number) => boolean) =>
        Effect.gen(function* () {
          const response = yield* api.request(
            session,
            "GET",
            `${prefix}/tasks/detail?range=7d&key=${encodeURIComponent(`task:${taskId}`)}`,
          );
          if (response.status === 404) return yield* Effect.fail(`No calls yet for ${taskId}`);
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          const detail = yield* body(TaskDetail, response);
          if (!ready(detail.calls.length))
            return yield* Effect.fail(`${taskId} has ${detail.calls.length} calls`);
          return detail;
        }).pipe(retry, Effect.orDie),
      list: (session: Session, ready: (tasks: (typeof TaskList.Type)["tasks"]) => boolean) =>
        Effect.gen(function* () {
          const response = yield* api.request(session, "GET", `${prefix}/tasks?range=7d&limit=100`);
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          const list = yield* body(TaskList, response);
          if (!ready(list.tasks))
            return yield* Effect.fail("The expected tasks are not listed yet");
          return list;
        }).pipe(retry, Effect.orDie),
    };
  });

layer(HostedLive, { excludeTestServices: true })("Task insights", (it) => {
  it.effect(scenarios.taskInsightsGrouping.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const app = yield* deployApp;
        const reader = yield* taskReader(actors.organization.id);
        const agent = yield* connectAgent(actors.owner, "Ticket agent");
        const echo = `tools[${JSON.stringify(app.slug)}].echo`;
        const explode = `tools[${JSON.stringify(app.slug)}].explode`;
        const call = (path: string, input: Record<string, unknown>) => ({ calls: { path, input } });

        // The task ID comes from the request metadata, from the argument, and with padding.
        const first = yield* agent.call("Echo with the task ID in _meta", {
          name: "call",
          arguments: call(echo, { text: "one" }),
          _meta: { [taskIdKey]: "T-4821" },
        });
        const second = yield* agent.call("Fail with a padded task ID in _meta", {
          name: "call",
          arguments: call(explode, {}),
          _meta: { [taskIdKey]: "  T-4821 " },
        });
        const third = yield* agent.call("Echo with the taskId argument", {
          name: "call",
          arguments: { ...call(echo, { text: "three" }), taskId: "T-4821" },
        });
        // The metadata wins over the argument, and an unusable value never fails the call.
        yield* agent.call("Echo with different IDs in _meta and the argument", {
          name: "call",
          arguments: { ...call(echo, { text: "other" }), taskId: "T-IGNORED" },
          _meta: { [taskIdKey]: "T-9000" },
        });
        const untagged = yield* agent.call("Echo with unusable task IDs", {
          name: "call",
          arguments: { ...call(echo, { text: "plain" }), taskId: 5 },
          _meta: { [taskIdKey]: "bad\nid" },
        });
        // Calls nested in an execute program belong to the task of the execute call.
        const nested = yield* agent.call("Execute two nested calls", {
          name: "execute",
          arguments: {
            code: `await ${echo}({ text: "n1" }); return await ${echo}({ text: "n2" });`,
            taskId: "T-NESTED",
          },
        });

        // Every result names its run, and its task when it has one.
        const runs = [first, second, third].map(resultMeta);
        for (const meta of runs) expect(meta[taskIdKey]).toBe("T-4821");
        expect(new Set(runs.map((meta) => meta["executor/runId"])).size).toBe(3);
        expect(resultMeta(untagged)[taskIdKey]).toBeUndefined();
        expect(resultMeta(untagged)["executor/runId"]).not.toBe("");
        expect(resultMeta(nested)[taskIdKey]).toBe("T-NESTED");

        const task = yield* reader.detail(actors.owner, "T-4821", (calls) => calls === 3);
        expect(task).toMatchObject({ key: "task:T-4821", kind: "task", label: "T-4821" });
        expect(task.calls.map((item) => item.toolName.split(".").at(-1))).toEqual([
          "echo",
          "explode",
          "echo",
        ]);
        expect(task.calls.map((item) => item.outcome)).toEqual(["success", "failure", "success"]);
        expect(task.calls[1]?.errorType).not.toBeNull();
        expect(task.calls[0]?.errorType).toBeNull();
        for (const item of task.calls) {
          expect(item.appId).toBe(app.id);
          expect(item.appName).toBe(app.name);
          expect(item.durationMs).toBeGreaterThanOrEqual(0);
          // Arguments are not recorded unless the organization turned that on.
          expect(item.arguments).toBeNull();
        }
        const times = task.calls.map((item) => Date.parse(item.at));
        expect(times).toEqual([...times].sort((a, b) => a - b));
        // Each top-level call has its own run, the one its result reported, in the same session.
        expect(task.calls.map((item) => item.runId)).toEqual(
          runs.map((meta) => meta["executor/runId"]),
        );
        expect(new Set(task.calls.map((item) => item.sessionId)).size).toBe(1);
        expect(task.calls[0]?.sessionId).not.toBeNull();

        // The calls nested in one execute share its run.
        const program = yield* reader.detail(actors.owner, "T-NESTED", (calls) => calls >= 2);
        expect(program.calls).toHaveLength(2);
        expect(program.calls.map((item) => item.runId)).toEqual([
          resultMeta(nested)["executor/runId"],
          resultMeta(nested)["executor/runId"],
        ]);

        // An approval-gated tool resumed later keeps the task and run of the execute that paused.
        const gated = yield* agent.call("Execute a tool that needs approval", {
          name: "execute",
          arguments: {
            code: `return await tools[${JSON.stringify(app.slug)}].approved({ text: "gated" });`,
            taskId: "T-GATED",
          },
        });
        const waiting = Schema.decodeUnknownSync(
          Schema.Struct({
            structuredContent: Schema.Struct({
              status: Schema.Literal("approval-required"),
              requestId: Schema.String,
            }),
          }),
        )(gated).structuredContent;
        const resumed = yield* agent.call("Approve the tool through resume", {
          name: "resume",
          arguments: { requestId: waiting.requestId, response: { action: "accept" } },
        });
        expect(resultMeta(resumed)["executor/runId"]).toBe(resultMeta(gated)["executor/runId"]);
        const approved = yield* reader.detail(actors.owner, "T-GATED", (calls) => calls === 1);
        expect(approved.calls[0]?.toolName.split(".").at(-1)).toBe("approved");
        expect(approved.calls[0]?.runId).toBe(resultMeta(gated)["executor/runId"]);

        // The list groups by task, newest first, and keeps calls without a task ID apart.
        const list = yield* reader.list(
          actors.owner,
          (tasks) =>
            tasks.some((item) => item.label === "T-4821" && item.calls === 3) &&
            tasks.some((item) => item.label === "T-9000") &&
            tasks.some((item) => item.kind !== "task"),
        );
        const summary = list.tasks.find((item) => item.label === "T-4821");
        expect(summary).toMatchObject({ kind: "task", calls: 3, failures: 1 });
        expect(summary?.apps).toEqual([{ appId: app.id, appName: app.name }]);
        expect(list.tasks.find((item) => item.label === "T-9000")?.calls).toBe(1);
        expect(list.tasks.some((item) => item.label === "T-IGNORED")).toBe(false);
        const ungrouped = list.tasks.find((item) => item.kind === "session");
        expect(ungrouped?.calls).toBe(1);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.taskInsightsArguments.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const app = yield* deployApp;
        const reader = yield* taskReader(actors.organization.id);
        const agent = yield* connectAgent(actors.owner, "Argument agent");
        const settingsPath = `/api/organizations/${actors.organization.id}/task-insights-settings`;
        const save = (payload: Record<string, unknown>) =>
          api.request(actors.owner, "PUT", settingsPath, payload);
        const sink = `tools[${JSON.stringify(app.slug)}].sink`;
        // Recording is off for everyone else again once the scenario ends.
        yield* Effect.addFinalizer(() =>
          save({ recordArguments: false, retentionDays: 30, extraMaskedKeys: [] }).pipe(
            Effect.orDie,
          ),
        );
        const run = (task: string, input: Record<string, unknown>) =>
          agent.call(`Call sink for ${task}`, {
            name: "call",
            arguments: { calls: { path: sink, input } },
            _meta: { [taskIdKey]: task },
          });

        // By default nothing about the arguments is stored.
        expect(
          yield* body(Settings, yield* api.request(actors.owner, "GET", settingsPath)),
        ).toEqual({
          recordArguments: false,
          recordResponses: false,
          retentionDays: 30,
          extraMaskedKeys: [],
          available: true,
        });
        yield* run("ARGS-OFF", { text: "visible while off", password: "hunter2-off" });
        const off = yield* reader.detail(actors.owner, "ARGS-OFF", (calls) => calls === 1);
        expect(off.calls[0]?.arguments).toBeNull();

        // Names to mask are trimmed and de-duplicated; too many or too long are refused.
        expect(
          (yield* save({ recordArguments: true, retentionDays: 45, extraMaskedKeys: [] })).status,
        ).toBe(400);
        expect(
          (yield* save({
            recordArguments: true,
            retentionDays: 7,
            extraMaskedKeys: ["x".repeat(65)],
          })).status,
        ).toBe(400);
        expect(
          (yield* save({
            recordArguments: true,
            retentionDays: 7,
            extraMaskedKeys: Array.from({ length: 51 }, (_, index) => `key${index}`),
          })).status,
        ).toBe(400);
        const saved = yield* body(
          Settings,
          yield* save({
            recordArguments: true,
            retentionDays: 7,
            extraMaskedKeys: ["  SSN ", "ssn", "account_number"],
          }),
        );
        expect(saved).toMatchObject({ recordArguments: true, retentionDays: 7 });
        expect(saved.extraMaskedKeys.map((key) => key.toLowerCase())).toEqual([
          "ssn",
          "account_number",
        ]);

        // Credentials are masked by key (also nested and in arrays), by look, and by the extra names.
        yield* run("ARGS-ON", {
          text: "hello",
          password: "hunter2-on",
          note: "use Bearer abcdefghijklmnop1234567890 for it",
          endpoint: "https://svc:s3cr3tpw@db.example.com/x",
          headers: [
            { name: "X-Api-Key", value: "hdr-secret-789" },
            { name: "Accept", value: "application/json" },
          ],
          label: "ghp_abcdefghijklmnopqrstuvwxyz0123",
          ssn: "123-45-6789",
          config: { apiKey: "key-value-123", region: "eu" },
          items: [{ token: "tok-value-456", name: "keep me" }],
        });
        const on = yield* reader.detail(actors.owner, "ARGS-ON", (calls) => calls === 1);
        const stored = on.calls[0]?.arguments ?? "";
        expect(JSON.parse(stored)).toEqual({
          text: "hello",
          password: "[masked]",
          note: "use [masked] for it",
          endpoint: "https://[masked]@db.example.com/x",
          headers: [
            { name: "X-Api-Key", value: "[masked]" },
            { name: "Accept", value: "application/json" },
          ],
          label: "[masked]",
          ssn: "[masked]",
          config: { apiKey: "[masked]", region: "eu" },
          items: [{ token: "[masked]", name: "keep me" }],
        });
        for (const secret of [
          "hunter2",
          "abcdefghijklmnop",
          "ghp_",
          "123-45-6789",
          "key-value-123",
          "tok-value-456",
          "s3cr3tpw",
          "hdr-secret-789",
        ])
          expect(stored).not.toContain(secret);

        // Calls nested in an execute program are recorded in order, masked, with the execute's run.
        const nested = yield* agent.call("Execute two nested sink calls", {
          name: "execute",
          arguments: {
            code: `await ${sink}({ text: "n1", password: "nested-secret-1" });
return await ${sink}({ text: "n2", password: "nested-secret-2" });`,
            taskId: "ARGS-NESTED",
          },
        });
        const nestedCalls = yield* reader.detail(
          actors.owner,
          "ARGS-NESTED",
          (calls) => calls === 2,
        );
        expect(
          nestedCalls.calls.map((item) => JSON.parse(item.arguments ?? "null") as unknown),
        ).toEqual([
          { text: "n1", password: "[masked]" },
          { text: "n2", password: "[masked]" },
        ]);
        expect(nestedCalls.calls.map((item) => item.runId)).toEqual([
          resultMeta(nested)["executor/runId"],
          resultMeta(nested)["executor/runId"],
        ]);

        // What is stored is capped, and says so when it was cut.
        yield* run("ARGS-BIG", { text: "big", big: "x".repeat(6000) });
        const big = yield* reader.detail(actors.owner, "ARGS-BIG", (calls) => calls === 1);
        const bigArguments = big.calls[0]?.arguments ?? "";
        expect(Buffer.byteLength(bigArguments)).toBeLessThanOrEqual(4096);
        expect(bigArguments).toContain("truncated");

        // Turning recording off stops it for new calls and deletes the arguments already stored.
        expect(
          (yield* save({ recordArguments: false, retentionDays: 7, extraMaskedKeys: [] })).status,
        ).toBe(200);
        for (const task of ["ARGS-ON", "ARGS-BIG", "ARGS-NESTED"]) {
          const scrubbed = yield* reader.detail(actors.owner, task, (calls) => calls >= 1);
          expect(scrubbed.calls.length).toBeGreaterThan(0);
          for (const item of scrubbed.calls) expect(item.arguments).toBeNull();
        }
        yield* run("ARGS-OFF-AGAIN", { text: "visible again" });
        const again = yield* reader.detail(actors.owner, "ARGS-OFF-AGAIN", (calls) => calls === 1);
        expect(again.calls[0]?.arguments).toBeNull();
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.taskInsightsResponses.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const app = yield* deployApp;
        const reader = yield* taskReader(actors.organization.id);
        const agent = yield* connectAgent(actors.owner, "Response agent");
        const prefix = `/api/organizations/${actors.organization.id}`;
        const settingsPath = `${prefix}/task-insights-settings`;
        const save = (payload: Record<string, unknown>) =>
          api.request(actors.owner, "PUT", settingsPath, payload);
        const tool = (name: string) => `tools[${JSON.stringify(app.slug)}].${name}`;
        yield* Effect.addFinalizer(() =>
          save({
            recordArguments: false,
            recordResponses: false,
            retentionDays: 30,
            extraMaskedKeys: [],
          }).pipe(Effect.orDie),
        );
        const run = (task: string, name: string, input: Record<string, unknown> = {}) =>
          agent.call(`Call ${name} for ${task}`, {
            name: "call",
            arguments: { calls: { path: tool(name), input } },
            _meta: { [taskIdKey]: task },
          });
        const single = (task: string) =>
          reader
            .detail(actors.owner, task, (calls) => calls === 1)
            .pipe(Effect.map((detail) => detail.calls[0]!));

        // Responses are not stored while only arguments are recorded.
        expect(
          (yield* save({ recordArguments: true, retentionDays: 7, extraMaskedKeys: [] })).status,
        ).toBe(200);
        yield* run("RESP-OFF", "secretive");
        const off = yield* single("RESP-OFF");
        expect(off.response).toBeNull();
        expect(off.files).toEqual([]);

        // A save without recordResponses keeps it as it was, and turning it on records responses.
        const on = yield* body(
          Settings,
          yield* save({
            recordArguments: true,
            recordResponses: true,
            retentionDays: 7,
            extraMaskedKeys: [],
          }),
        );
        expect(on).toMatchObject({ recordArguments: true, recordResponses: true });
        const kept = yield* body(
          Settings,
          yield* save({ recordArguments: true, retentionDays: 7, extraMaskedKeys: [] }),
        );
        expect(kept.recordResponses).toBe(true);

        yield* run("RESP-SECRET", "secretive");
        const secret = yield* single("RESP-SECRET");
        const secretResponse = secret.response ?? "";
        expect(JSON.parse(secretResponse)).toEqual({
          apiKey: "[masked]",
          region: "eu",
          note: "kept",
        });
        expect(secretResponse).not.toContain("resp-key-123");

        // Inline media is saved as organization files and replaced by their addresses.
        yield* run("RESP-IMAGE", "picture");
        yield* run("RESP-DATA", "inline");
        yield* run("RESP-HANDLE", "stored");
        const media = yield* Effect.all(
          ["RESP-IMAGE", "RESP-DATA", "RESP-HANDLE"].map((task) =>
            reader
              .detail(actors.owner, task, (calls) => calls === 1)
              .pipe(
                Effect.flatMap((detail) => {
                  const item = detail.calls[0]!;
                  return item.response !== null && item.files.length === 1
                    ? Effect.succeed(item)
                    : Effect.fail(`${task} is not complete`);
                }),
                Effect.retry({ schedule: Schedule.spaced(Duration.millis(500)), times: 20 }),
                Effect.orDie,
              ),
          ),
        );
        const listed = yield* body(
          Schema.Struct({
            files: Schema.Array(Schema.Struct({ id: Schema.String, contentType: Schema.String })),
          }),
          yield* api.request(actors.owner, "GET", `${prefix}/files`),
        );
        for (const [index, item] of media.entries()) {
          const file = item.files[0]!;
          expect(file.uri).toBe(`executor-file://${actors.organization.id}/${file.id}`);
          expect(file.available).toBe(true);
          expect(item.response).toContain(file.uri);
          expect(item.response).not.toContain("iVBORw0KGgo");
          const entry = listed.files.find((candidate) => candidate.id === file.id);
          expect(entry?.contentType).toBe(index === 2 ? "text/plain" : "image/png");
          expect(file.contentType).toBe(entry?.contentType);
        }

        // A long response is cut and says how large it was.
        yield* run("RESP-BIG", "huge");
        const big = (yield* single("RESP-BIG")).response ?? "";
        expect(Buffer.byteLength(big)).toBeLessThanOrEqual(16384);
        expect(big).toMatch(/…\[truncated, [\d.]+ ?[A-Za-z]+ total\]$/);

        // Turning responses off deletes them and keeps the arguments.
        yield* run("RESP-ARGS", "secretive");
        yield* single("RESP-ARGS");
        expect(
          (yield* save({
            recordArguments: true,
            recordResponses: false,
            retentionDays: 7,
            extraMaskedKeys: [],
          })).status,
        ).toBe(200);
        for (const task of ["RESP-SECRET", "RESP-BIG", "RESP-IMAGE"]) {
          const scrubbed = yield* single(task);
          expect(scrubbed.response).toBeNull();
          expect(scrubbed.arguments).not.toBeNull();
        }
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.taskInsightsAccess.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const app = yield* deployApp;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const reader = yield* taskReader(actors.organization.id);
        const echo = `tools[${JSON.stringify(app.slug)}].echo`;
        const member = yield* connectAgent(actors.member, "Member task agent");
        yield* member.call("Member echoes for a task", {
          name: "call",
          arguments: { calls: { path: echo, input: { text: "mine" } } },
          _meta: { [taskIdKey]: "MEMBER-TASK" },
        });

        // Owners and admins read the task; members are refused the list, the detail and the setting.
        const seen = yield* reader.detail(actors.owner, "MEMBER-TASK", (calls) => calls === 1);
        expect(seen.calls).toHaveLength(1);
        expect((yield* api.request(actors.admin, "GET", `${prefix}/tasks?range=7d`)).status).toBe(
          200,
        );
        const key = encodeURIComponent("task:MEMBER-TASK");
        for (const path of [
          `${prefix}/tasks?range=7d`,
          `${prefix}/tasks/detail?range=7d&key=${key}`,
        ])
          expect((yield* api.request(actors.member, "GET", path)).status).toBe(403);
        const settingsPath = `${prefix}/task-insights-settings`;
        expect((yield* api.request(actors.member, "GET", settingsPath)).status).toBe(403);
        expect(
          (yield* api.request(actors.member, "PUT", settingsPath, {
            recordArguments: true,
            retentionDays: 90,
            extraMaskedKeys: [],
          })).status,
        ).toBe(403);
        expect(
          (yield* body(Settings, yield* api.request(actors.admin, "GET", settingsPath)))
            .recordArguments,
        ).toBe(false);

        // Someone who belongs to another organization only is refused this organization's tasks.
        const outsiderEmail = `outsider-${randomUUID().slice(0, 8)}@example.test`;
        const sessions = yield* SessionClients;
        const owned = yield* body(
          Organization,
          yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
            name: "Outsider home",
            slug: `outsider-home-${randomUUID().slice(0, 8)}`,
            keepCurrentActiveOrganization: true,
          }),
        );
        const invitation = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", "/api/auth/organization/invite-member", {
            email: outsiderEmail,
            role: "member",
            organizationId: owned.id,
            resend: true,
          }),
        );
        const outsider = yield* sessions.session();
        expect(
          (yield* sessions.request(outsider, "POST", "/api/auth/self-host/register", {
            invitation: invitation.id,
            email: outsiderEmail,
            name: "Task outsider",
            password,
          })).status,
        ).toBe(200);
        const outsiderKey = encodeURIComponent("task:MEMBER-TASK");
        for (const path of [
          `${prefix}/tasks?range=7d`,
          `${prefix}/tasks/detail?range=7d&key=${outsiderKey}`,
          `${prefix}/task-insights-settings`,
        ])
          expect((yield* sessions.request(outsider, "GET", path)).status, path).toBe(403);

        // Another organization has its own tasks: none of this one's appear there.
        const other = yield* body(
          Organization,
          yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
            name: "Other tasks",
            slug: `other-tasks-${randomUUID().slice(0, 8)}`,
            keepCurrentActiveOrganization: true,
          }),
        );
        const otherList = yield* body(
          TaskList,
          yield* api.request(actors.owner, "GET", `/api/organizations/${other.id}/tasks?range=7d`),
        );
        expect(otherList.tasks.map((item) => item.label)).not.toContain("MEMBER-TASK");
        expect(
          (yield* api.request(
            actors.owner,
            "GET",
            `/api/organizations/${other.id}/tasks/detail?range=7d&key=${key}`,
          )).status,
        ).toBe(404);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
