/** A deployed app whose tools keep and read files through `ctx.blobs`, for the file-handle scenarios. */
import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "./api.ts";
import { App } from "./contracts.ts";
import { appsManifest, databaseFiles } from "./apps-release.ts";

/** A handle as a tool returns it. */
export const Handle = Schema.Struct({
  id: Schema.String,
  sha256: Schema.String,
  size: Schema.Number,
  contentType: Schema.String,
  expiresAt: Schema.String,
});
export type Handle = typeof Handle.Type;
/** A typed failure as the fixture tools report it: the error's tag and the fields it carries. */
export const Failure = Schema.Struct({
  error: Schema.Struct({
    _tag: Schema.String,
    maximum: Schema.optional(Schema.Number),
    requested: Schema.optional(Schema.Number),
    reason: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Number),
  }),
});

const source = [
  {
    path: "index.ts",
    content: `
import { defineApp, query, object, string, number, record, router } from "apps";
const handle = object({ id: string(), sha256: string(), size: number(), contentType: string(), expiresAt: string() });
const attempt = async run => {
  try { return await run(); }
  catch (error) {
    const { _tag, maximum, requested, reason, status } = error;
    // JSON drops the fields an error does not carry; a tool result may not hold undefined.
    return JSON.parse(JSON.stringify({ error: { _tag: _tag ?? "Unknown", maximum, requested, reason, status } }));
  }
};
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
export default defineApp({}, async ctx => ({
  tools: router({
    limits: query({ input: object({}) }, async () => ctx.blobs.limits()),
    capture: query({ input: object({ url: string(), contentType: string().optional(), expectedSize: number().optional(), expectedSha256: string().optional(), headers: record(string()).optional() }) },
      async (_, input) => attempt(async () => ({ handle: await ctx.blobs.fromUrl(input.url, {
        ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
        ...(input.expectedSize === undefined ? {} : { expectedSize: input.expectedSize }),
        ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
        ...(input.headers === undefined ? {} : { headers: input.headers }),
      }) }))),
    captureText: query({ input: object({ text: string(), contentType: string().optional() }) },
      async (_, input) => attempt(async () => ({ handle: await ctx.blobs.create(new TextEncoder().encode(input.text), input.contentType === undefined ? {} : { contentType: input.contentType }) }))),
    captureBytes: query({ input: object({ size: number() }) },
      async (_, input) => attempt(async () => ({ handle: await ctx.blobs.create(new Uint8Array(input.size).fill(65)) }))),
    stat: query({ input: object({ id: string() }) },
      async (_, input) => attempt(async () => ({ handle: await ctx.blobs.stat({ id: input.id }) }))),
    link: query({ input: object({ id: string(), expiresInSeconds: number().optional(), filename: string().optional() }) },
      async (_, input) => attempt(async () => ({ link: await ctx.blobs.url({ id: input.id }, {
        ...(input.expiresInSeconds === undefined ? {} : { expiresInSeconds: input.expiresInSeconds }),
        ...(input.filename === undefined ? {} : { filename: input.filename }),
      }) }))),
    slice: query({ input: object({ handle, offset: number(), length: number() }) },
      async (_, input) => attempt(async () => {
        const bytes = await ctx.blobs.read(input.handle, { offset: input.offset, length: input.length });
        return { length: bytes.length, hex: hex(bytes) };
      })),
    digest: query({ input: object({ handle, offset: number(), length: number() }) },
      async (_, input) => attempt(async () => {
        const bytes = await ctx.blobs.read(input.handle, { offset: input.offset, length: input.length });
        return { length: bytes.length, sha256: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) };
      })),
    remove: query({ input: object({ id: string() }) },
      async (_, input) => attempt(async () => { await ctx.blobs.delete({ id: input.id }); return { removed: true }; })),
  }),
}));
`,
  },
  appsManifest,
];

/**
 * Deploy the file app to `organization` as `owner`, open to everyone there, and remove it with the
 * scope. With `database`, the app owns a database, so its calls run in its data facet.
 */
export const blobApp = (
  owner: Session,
  organization: string,
  options: { readonly database?: boolean } = {},
) =>
  Effect.gen(function* () {
    const files = [...source, ...databaseFiles(options.database)];
    const api = yield* Api;
    const prefix = `/api/organizations/${organization}/apps`;
    const deployed = yield* api.request(owner, "POST", `${prefix}/deploy`, {
      name: `Files ${randomUUID().slice(0, 8)}`,
      files,
    });
    expect(deployed.status).toBe(200);
    const app = (yield* body(App, deployed)).id;
    const path = `${prefix}/${app}`;
    yield* Effect.addFinalizer(() => api.request(owner, "DELETE", path).pipe(Effect.orDie));
    const access = yield* body(
      Schema.Struct({ revision: Schema.String }),
      yield* api.request(owner, "GET", `${path}/access`),
    );
    expect(
      (yield* api.request(owner, "PATCH", `${path}/access`, {
        revision: access.revision,
        audience: { kind: "everyone" },
      })).status,
    ).toBe(200);
    /** The size of the JSON a call returned, for the claim that a tool result stays small. */
    const call = (name: string, input: Schema.Json = {}, as: Session = owner) =>
      Effect.gen(function* () {
        const response = yield* api.request(as, "POST", `${path}/tools/call`, {
          tool: name,
          kind: "query",
          input,
        });
        expect(response.status, `${name}: ${JSON.stringify(response.body).slice(0, 500)}`).toBe(
          200,
        );
        const value = yield* body(Schema.Json, response);
        return { value, size: JSON.stringify(value).length };
      });
    /** A call that returns a handle. */
    const capture = (name: string, input: Schema.Json) =>
      Effect.gen(function* () {
        const { value, size } = yield* call(name, input);
        return {
          handle: (yield* Schema.decodeUnknownEffect(Schema.Struct({ handle: Handle }))(value))
            .handle,
          size,
        };
      });
    /** A call that is expected to report a typed failure. */
    const failure = (name: string, input: Schema.Json) =>
      call(name, input).pipe(
        Effect.flatMap(({ value }) => Schema.decodeUnknownEffect(Failure)(value)),
        Effect.map((reported) => reported.error),
      );
    return { call, capture, failure, id: app };
  });
