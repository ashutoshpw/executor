/**
 * Files in MCP. A tool returns a file handle inside its value; the MCP result then also carries a
 * `resource_link` to `executor-file://<organization>/<id>`, and `resources/read` returns the bytes
 * on request. The bytes never travel in a tool result, only in that separate read, and only up to
 * the host's resource limit (these scenarios lower it to 64 KiB); a larger file fails with a typed
 * error that names a signed download link.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomUUID } from "node:crypto";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { blobApp, Handle } from "../support/blob-app.ts";
import { blobUpstream, files, sha256Hex } from "../support/blob-upstream.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Organization } from "../support/contracts.ts";
import { McpClient } from "../support/mcp-client.ts";
import { ConnectionView, consentTo, revokeClientGrants } from "../support/mcp-connections.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

/** The bound these scenarios give `resources/read`. */
const readLimit = 64 * 1024;
/** MCP's code for a resource that does not exist; the server uses it for every unreadable file. */
const resourceNotFound = -32002;
const hour = 60 * 60 * 1000;
const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });

/** A fresh organization owned by the scenario's owner, so handles never meet another scenario's. */
const createOrganization = (name: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const actors = yield* Actors;
    return yield* body(
      Organization,
      yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
        name,
        slug: `${name.toLowerCase().replaceAll(" ", "-")}-${randomUUID().slice(0, 8)}`,
        keepCurrentActiveOrganization: true,
      }),
    );
  });

/** A personal access token for the owner; each client names its organization in a header. */
const accessKey = Effect.gen(function* () {
  const api = yield* Api;
  const actors = yield* Actors;
  const key = yield* body(
    Key,
    yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
      name: "File resources",
    }),
  );
  yield* Effect.addFinalizer(() =>
    api
      .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
      .pipe(Effect.orDie),
  );
  return key.key;
});

const Link = Schema.Struct({
  type: Schema.Literal("resource_link"),
  uri: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
  _meta: Schema.Struct({ sha256: Schema.String, expiresAt: Schema.String }),
});
const Text = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});
const Captured = Schema.Struct({ handle: Handle });
const CalledCapture = Schema.Struct({ value: Captured });
const Contents = Schema.Struct({
  uri: Schema.String,
  mimeType: Schema.String,
  text: Schema.optional(Schema.String),
  blob: Schema.optional(Schema.String),
  _meta: Schema.Struct({ sha256: Schema.String, size: Schema.Number, expiresAt: Schema.String }),
});

/** What a read answered: its contents, or the JSON-RPC error with its code, message and data. */
type Read =
  | { readonly ok: true; readonly contents: typeof Contents.Type }
  | {
      readonly ok: false;
      readonly code: number;
      readonly message: string;
      readonly data: unknown;
    };

/** `resources/read` of `uri`, with a refusal returned as data instead of a failed step. */
const readResource = (client: Connection, uri: string) =>
  client.use(`Read ${uri}`, (mcp: Client, signal) =>
    mcp.readResource({ uri }, { signal }).then(
      (result): Promise<Read> =>
        Promise.resolve({
          ok: true,
          contents: Schema.decodeUnknownSync(Contents)(result.contents[0]),
        }),
      (error: unknown): Promise<Read> =>
        error instanceof McpError
          ? Promise.resolve({
              ok: false,
              code: error.code,
              message: error.message,
              data: error.data,
            })
          : Promise.reject(error),
    ),
  );
type Connection = Effect.Success<ReturnType<McpClient["Service"]["connect"]>>;

/** One tool result as a client receives it: its content blocks and structured content. */
interface ToolResult {
  readonly content: ReadonlyArray<unknown>;
  readonly structuredContent: unknown;
  readonly bytes: number;
}
const callMcp = (client: Connection, name: string, args: Record<string, unknown>) =>
  client.use(`Call ${name}`, (mcp: Client, signal) =>
    mcp.callTool({ name, arguments: args }, undefined, { signal }).then((result): ToolResult => ({
      content: result.content as ReadonlyArray<unknown>,
      structuredContent: result.structuredContent,
      bytes: Buffer.byteLength(JSON.stringify(result)),
    })),
  );

/** The `resource_link` blocks of a result, after its leading text block. */
const linksOf = (result: ToolResult) =>
  Effect.gen(function* () {
    expect(result.content.length).toBeGreaterThan(0);
    yield* Schema.decodeUnknownEffect(Text)(result.content[0]);
    return yield* Schema.decodeUnknownEffect(Schema.Array(Link))(result.content.slice(1));
  });

/** Run one app tool through `call`: the handle it returned and the result as the client saw it. */
const capturedByCall = (
  client: Connection,
  slug: string,
  tool: string,
  input: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const result = yield* callMcp(client, "call", {
      calls: { path: `tools[${JSON.stringify(slug)}].${tool}`, input },
    });
    const completed = yield* Schema.decodeUnknownEffect(Completed)(result.structuredContent);
    const { value } = yield* Schema.decodeUnknownEffect(CalledCapture)(completed.execution.value);
    return { handle: value.handle, result };
  });

/** Run a program through `execute`; `code` returns the value to inspect. */
const executed = (client: Connection, code: string) =>
  Effect.gen(function* () {
    const result = yield* callMcp(client, "execute", { code });
    const completed = yield* Schema.decodeUnknownEffect(Completed)(result.structuredContent);
    return { value: completed.execution.value, result };
  });

const toolPath = (slug: string, tool: string) => `tools[${JSON.stringify(slug)}].${tool}`;

layer(HostedLive, { excludeTestServices: true })("MCP file resources", (it) => {
  it.effect(scenarios.mcpFileResourceLinks.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const mcp = yield* McpClient;
        const actors = yield* Actors;
        const target = yield* Target;
        const http = yield* HttpClient.HttpClient;
        const upstream = yield* blobUpstream;
        const key = yield* accessKey;
        const org = yield* createOrganization("Resource links");
        const app = yield* blobApp(actors.owner, org.id);
        const client = yield* mcp.connect(key, "file-links", { organization: org.id });

        // The server advertises resources and one template, and lists no resource: static lists
        // are server-wide, so a file list would cross organizations.
        const capabilities = yield* client.use("Read the server capabilities", (mcp) =>
          Promise.resolve(mcp.getServerCapabilities()),
        );
        expect(capabilities?.resources).toBeDefined();
        const templates = yield* client.use("List resource templates", (mcp) =>
          mcp.listResourceTemplates(),
        );
        expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toEqual([
          "executor-file://{org}/{id}",
        ]);
        const listed = yield* client.use("List resources", (mcp) => mcp.listResources());
        expect(listed.resources).toEqual([]);

        // A binary file through `call`: the handle stays in the structured result, a link follows
        // the text block, and neither the result nor its link holds the file.
        const binary = yield* capturedByCall(client, app.slug, "captureBytes", { size: 40_960 });
        const [binaryLink] = yield* linksOf(binary.result);
        expect(binary.result.content).toHaveLength(2);
        expect(binaryLink?.uri).toBe(`executor-file://${org.id}/${binary.handle.id}`);
        expect(binaryLink?.size).toBe(40_960);
        expect(binaryLink?.mimeType).toBe(binary.handle.contentType);
        expect(binaryLink?._meta.sha256).toBe(binary.handle.sha256);
        expect(binary.result.bytes).toBeLessThan(4096);
        const bytes = new Uint8Array(40_960).fill(65);
        const read = yield* readResource(client, binaryLink?.uri ?? "");
        expect(read.ok).toBe(true);
        if (read.ok) {
          expect(read.contents.text).toBeUndefined();
          const returned = Buffer.from(read.contents.blob ?? "", "base64");
          expect(sha256Hex(returned)).toBe(sha256Hex(bytes));
          expect(read.contents.mimeType).toBe(binary.handle.contentType);
          expect(read.contents._meta.sha256).toBe(binary.handle.sha256);
        }

        // Text through `execute`: the program returns the handle, and the same link follows.
        const text = "héllo wörld\nsecond line\n";
        const program = yield* executed(
          client,
          `return await ${toolPath(app.slug, "captureText")}({ text: ${JSON.stringify(text)}, contentType: "text/plain; charset=utf-8" });`,
        );
        const { handle: textHandle } = yield* Schema.decodeUnknownEffect(Captured)(program.value);
        const [textLink] = yield* linksOf(program.result);
        expect(textLink?.uri).toBe(`executor-file://${org.id}/${textHandle.id}`);
        const readText = yield* readResource(client, textLink?.uri ?? "");
        expect(readText.ok && readText.contents.text).toBe(text);
        expect(readText.ok && readText.contents.blob).toBeUndefined();

        // Random bytes labeled text are not UTF-8: they come back as exact bytes, never as text
        // with replacement characters. This one is exactly at the bound.
        const labeled = yield* capturedByCall(client, app.slug, "capture", {
          url: upstream.url("blob", "other"),
          contentType: "text/plain",
        });
        expect(labeled.handle.size).toBe(readLimit);
        const readLabeled = yield* readResource(
          client,
          (yield* linksOf(labeled.result))[0]?.uri ?? "",
        );
        expect(readLabeled.ok).toBe(true);
        if (readLabeled.ok) {
          expect(readLabeled.contents.text).toBeUndefined();
          expect(sha256Hex(Buffer.from(readLabeled.contents.blob ?? "", "base64"))).toBe(
            sha256Hex(files.other.bytes),
          );
        }

        // Many files in one result: links stop at the cap, and the metadata they add stays well
        // inside the fixed allowance on top of the output ceiling.
        const many = yield* executed(
          client,
          `const made = await Promise.all(Array.from({ length: 24 }, (_, i) => ${toolPath(app.slug, "captureText")}({ text: "file " + i, contentType: "text/plain" })));
           return made.map((entry) => entry.handle);`,
        );
        const manyLinks = yield* linksOf(many.result);
        expect(manyLinks).toHaveLength(20);
        expect(Buffer.byteLength(JSON.stringify(many.result.content.slice(1)))).toBeLessThan(
          16_000,
        );

        // A result with no file has no link, and the output limit never moved: a program that
        // returns more than it still fails to.
        const plain = yield* executed(client, "return 42;");
        expect(plain.value).toBe(42);
        expect(plain.result.content).toHaveLength(1);

        // A client on a revision before resource_link gets the result unchanged, handle and all.
        const credentials = {
          authorization: `Bearer ${Redacted.value(key)}`,
          "x-executor-organization": org.id,
        };
        const rpc = (message: object, session?: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              const response = yield* http.execute(
                HttpClientRequest.post(new URL("/mcp", target.metadata.origin), {
                  headers: {
                    ...credentials,
                    accept: "application/json, text/event-stream",
                    ...(session === undefined ? {} : { "mcp-session-id": session }),
                  },
                }).pipe(HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", ...message })),
              );
              const raw = yield* response.text;
              const data = response.headers["content-type"]?.startsWith("text/event-stream")
                ? raw
                    .split("\n")
                    .filter((line) => line.startsWith("data: ") && line.length > 6)
                    .map((line) => line.slice(6))
                    .at(-1)
                : raw;
              return { session: response.headers["mcp-session-id"], data };
            }),
          ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
        const opened = yield* rpc({
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "executor-e2e-2025-03-26", version: "1" },
          },
        });
        const session = opened.session;
        expect(session).toBeDefined();
        yield* rpc({ method: "notifications/initialized" }, session);
        const legacy = yield* rpc(
          {
            id: 2,
            method: "tools/call",
            params: {
              name: "execute",
              arguments: {
                code: `return await ${toolPath(app.slug, "captureText")}({ text: "legacy" });`,
              },
            },
          },
          session,
        );
        const answer = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              result: Schema.Struct({ content: Schema.Array(Schema.Unknown) }),
            }),
          ),
        )(legacy.data ?? "");
        expect(answer.result.content).toHaveLength(1);
        expect(JSON.stringify(answer.result.content)).toContain("handle");
        expect(JSON.stringify(answer.result.content)).not.toContain("resource_link");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpFileResourceAuthorization.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const mcp = yield* McpClient;
        const actors = yield* Actors;
        const api = yield* Api;
        const key = yield* accessKey;
        const orgA = yield* createOrganization("Resources A");
        const orgB = yield* createOrganization("Resources B");
        const appA = yield* blobApp(actors.owner, orgA.id);
        yield* blobApp(actors.owner, orgB.id);
        const clientA = yield* mcp.connect(key, "resources-a", { organization: orgA.id });
        const clientB = yield* mcp.connect(key, "resources-b", { organization: orgB.id });

        const mine = yield* capturedByCall(clientA, appA.slug, "captureText", {
          text: "organization A's file",
          contentType: "text/plain",
        });
        const uri = `executor-file://${orgA.id}/${mine.handle.id}`;
        expect((yield* linksOf(mine.result))[0]?.uri).toBe(uri);
        const owner = yield* readResource(clientA, uri);
        expect(owner.ok && owner.contents.text).toBe("organization A's file");

        // Another organization's session, with A's URI or with its own organization in it, reads
        // the same "not found" as a handle that never existed: nothing says the file exists.
        const missing = yield* readResource(clientB, `executor-file://${orgB.id}/${randomUUID()}`);
        const other = yield* readResource(clientB, uri);
        const relabeled = yield* readResource(
          clientB,
          `executor-file://${orgB.id}/${mine.handle.id}`,
        );
        const crossed = yield* readResource(
          clientA,
          `executor-file://${orgB.id}/${mine.handle.id}`,
        );
        for (const refused of [missing, other, relabeled, crossed]) {
          expect(refused.ok).toBe(false);
          if (!refused.ok) {
            expect(refused.code).toBe(resourceNotFound);
            expect(refused.message).toContain("Resource not found");
          }
        }
        const malformed = yield* readResource(clientA, `executor-file://${orgA.id}/a/b`);
        expect(malformed.ok).toBe(false);
        if (!malformed.ok) expect(malformed.code).toBe(resourceNotFound);

        // An empty file is a file: it reads as empty text, not as missing.
        const empty = yield* capturedByCall(clientA, appA.slug, "captureText", {
          text: "",
          contentType: "text/plain",
        });
        expect(empty.handle.size).toBe(0);
        const emptyRead = yield* readResource(
          clientA,
          (yield* linksOf(empty.result))[0]?.uri ?? "",
        );
        expect(emptyRead.ok).toBe(true);
        if (emptyRead.ok) {
          expect(emptyRead.contents.text ?? emptyRead.contents.blob).toBe("");
          expect(emptyRead.contents._meta.size).toBe(0);
        }

        // A result holding an unowned handle-shaped object beside a real handle links only the
        // real one.
        const mixed = yield* executed(
          clientA,
          `return { real: ${JSON.stringify(mine.handle)}, fake: { id: ${JSON.stringify(randomUUID())}, sha256: "${"1".repeat(64)}", size: 3, contentType: "text/plain", expiresAt: ${JSON.stringify(new Date(Date.now() + hour).toISOString())} } };`,
        );
        const mixedLinks = yield* linksOf(mixed.result);
        expect(mixedLinks.map((link) => link.uri)).toEqual([uri]);

        // An app that returns a handle it made up, or another organization's real one, gets no
        // link: the host checks every handle-shaped value against the caller's own files.
        const forged = {
          id: randomUUID(),
          sha256: "0".repeat(64),
          size: 12,
          contentType: "text/plain",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        };
        const forgedResult = yield* executed(
          clientA,
          `return { handle: ${JSON.stringify(forged)} };`,
        );
        expect(forgedResult.result.content).toHaveLength(1);
        const stolen = yield* executed(
          clientB,
          `return { handle: ${JSON.stringify(mine.handle)} };`,
        );
        expect(stolen.result.content).toHaveLength(1);
        // The handle in the structured result is the program's value, byte for byte.
        expect(forgedResult.value).toEqual({ handle: forged });

        // A deleted file is gone for its owner too.
        const doomed = yield* capturedByCall(clientA, appA.slug, "captureText", { text: "doomed" });
        const doomedUri = `executor-file://${orgA.id}/${doomed.handle.id}`;
        expect((yield* readResource(clientA, doomedUri)).ok).toBe(true);
        yield* appA.call("remove", { id: doomed.handle.id });
        const removed = yield* readResource(clientA, doomedUri);
        expect(removed.ok).toBe(false);
        const afterRemoval = yield* executed(
          clientA,
          `return { handle: ${JSON.stringify(doomed.handle)} };`,
        );
        expect(afterRemoval.result.content).toHaveLength(1);

        // A scoped connection reaches only the tools it names; no file permission exists to grant,
        // so a handle's id alone must not widen it: no link, and a typed refusal on read.
        const owner2 = actors.owner;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const scopedApp = yield* blobApp(owner2, actors.organization.id);
        const created = yield* api.request(owner2, "POST", `${prefix}/mcp-connections`, {
          id: randomUUID(),
          name: `Connection ${randomUUID().slice(0, 6)}`,
          apps: [{ app: scopedApp.id, runsAs: [{ kind: "app" }], tools: { kind: "all" } }],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);
        yield* Effect.addFinalizer(() =>
          api
            .request(owner2, "POST", `${prefix}/mcp-connections/${connection.id}/revoke`)
            .pipe(Effect.orDie),
        );
        const consent = yield* consentTo(owner2, connection.url);
        yield* revokeClientGrants(owner2, () => [consent.clientId]);
        const scoped = yield* mcp.connect(yield* consent.tokens, "resources-scoped", {
          connection: connection.id,
        });
        const viaScope = yield* capturedByCall(scoped, scopedApp.slug, "captureText", {
          text: "scoped",
          contentType: "text/plain",
        });
        expect(viaScope.result.content).toHaveLength(1);
        const scopedRead = yield* readResource(
          scoped,
          `executor-file://${actors.organization.id}/${viaScope.handle.id}`,
        );
        expect(scopedRead.ok).toBe(false);
        if (!scopedRead.ok) expect(scopedRead.data).toMatchObject({ _tag: "FileForbidden" });
        // The same file reads fine with the full-access credential.
        const full = yield* mcp.connect(key, "resources-full", {
          organization: actors.organization.id,
        });
        const viaFull = yield* readResource(
          full,
          `executor-file://${actors.organization.id}/${viaScope.handle.id}`,
        );
        expect(viaFull.ok && viaFull.contents.text).toBe("scoped");
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpFileResourceExpiry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const mcp = yield* McpClient;
        const actors = yield* Actors;
        const api = yield* Api;
        const key = yield* accessKey;
        const org = yield* createOrganization("Resources expiry");
        const app = yield* blobApp(actors.owner, org.id);
        const client = yield* mcp.connect(key, "file-expiry", { organization: org.id });
        // The shortest lifetime an organization may choose, so one clock jump expires the file.
        const saved = yield* api.request(
          actors.owner,
          "PUT",
          `/api/organizations/${org.id}/blob-settings`,
          { ttlSeconds: 60 * 60 },
        );
        expect(saved.status).toBe(200);
        const short = yield* capturedByCall(client, app.slug, "captureText", {
          text: "short-lived",
          contentType: "text/plain",
        });
        const uri = (yield* linksOf(short.result))[0]?.uri ?? "";
        const before = yield* readResource(client, uri);
        expect(before.ok && before.contents.text).toBe("short-lived");

        yield* serverControl("clock/advance", 200, { milliseconds: 2 * hour });
        const expired = yield* readResource(client, uri);
        expect(expired.ok).toBe(false);
        if (!expired.ok) {
          expect(expired.code).toBe(resourceNotFound);
          expect(expired.message).toContain("Resource not found");
        }
        // An expired handle in a later result gets no link.
        const again = yield* executed(
          client,
          `return { handle: ${JSON.stringify(short.handle)} };`,
        );
        expect(again.result.content).toHaveLength(1);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );

  it.effect(scenarios.mcpFileResourceOversize.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const mcp = yield* McpClient;
        const actors = yield* Actors;
        const key = yield* accessKey;
        const upstream = yield* blobUpstream;
        const http = yield* HttpClient.HttpClient;
        const target = yield* Target;
        const org = yield* createOrganization("Resources large");
        const app = yield* blobApp(actors.owner, org.id);
        const client = yield* mcp.connect(key, "file-oversize", { organization: org.id });

        // One byte over the bound is refused before any byte is read.
        const large = yield* capturedByCall(client, app.slug, "capture", {
          url: upstream.url("blob", "small"),
        });
        expect(large.handle.size).toBe(files.small.bytes.length);
        // The result is still a small link: the bound is on reading, not on linking.
        const [link] = yield* linksOf(large.result);
        expect(link?.size).toBe(files.small.bytes.length);
        expect(large.result.bytes).toBeLessThan(4096);
        const refused = yield* readResource(client, link?.uri ?? "");
        expect(refused.ok).toBe(false);
        if (refused.ok) return;
        expect(refused.code).toBe(-32602);
        const data = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            _tag: Schema.Literal("FileTooLarge"),
            id: Schema.String,
            size: Schema.Number,
            maxResourceReadBytes: Schema.Number,
            sha256: Schema.String,
            url: Schema.String,
            expiresAt: Schema.String,
            cli: Schema.String,
          }),
        )(refused.data);
        expect(data.id).toBe(large.handle.id);
        expect(data.size).toBe(files.small.bytes.length);
        expect(data.maxResourceReadBytes).toBe(readLimit);
        expect(data.sha256).toBe(large.handle.sha256);
        expect(data.cli).toBe(`executor files get ${large.handle.id}`);
        // A client that shows only the message still has the way out.
        expect(refused.message).toContain(data.url);
        expect(refused.message).toContain(data.cli);

        // The signed link downloads the exact bytes without any credential.
        const downloaded = yield* Effect.scoped(
          Effect.gen(function* () {
            const response = yield* http.execute(
              HttpClientRequest.get(new URL(data.url, target.metadata.origin)),
            );
            return { status: response.status, bytes: new Uint8Array(yield* response.arrayBuffer) };
          }),
        ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
        expect(downloaded.status).toBe(200);
        expect(sha256Hex(downloaded.bytes)).toBe(large.handle.sha256);
        expect(downloaded.bytes.length).toBe(files.small.bytes.length);

        // The bound is inclusive: the file at exactly 64 KiB reads in full.
        const exact = yield* capturedByCall(client, app.slug, "capture", {
          url: upstream.url("blob", "other"),
        });
        const readExact = yield* readResource(client, (yield* linksOf(exact.result))[0]?.uri ?? "");
        expect(readExact.ok).toBe(true);
        expect(
          readExact.ok && sha256Hex(Buffer.from(readExact.contents.blob ?? "", "base64")),
        ).toBe(sha256Hex(files.other.bytes));
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
