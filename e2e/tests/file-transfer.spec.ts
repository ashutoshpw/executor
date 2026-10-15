/**
 * Files move over HTTP: a short-lived link downloads exact ranges and takes uploads without any
 * credential, an authenticated caller does the same by organization, and the `executor files`
 * CLI drives both. Every route ends in the same serving code, so what a link grants is what the
 * organization's credential would.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Redacted, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { blobApp, Handle } from "../support/blob-app.ts";
import { blobUpstream, files, generatedBytes, sha256Hex } from "../support/blob-upstream.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { Organization } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { localEntryCommand } from "../support/local-entry.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const mebibyte = 1024 * 1024;
const Link = Schema.Struct({ url: Schema.String, expiresAt: Schema.String });
const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const Resource = Schema.Struct({ id: Schema.String });
const SessionIdentity = Schema.Struct({ user: Schema.Struct({ email: Schema.String }) });
/** An error body as every Executor host writes it. */
const Failure = Schema.Struct({ _tag: Schema.String, message: Schema.String });
const LinkResult = Schema.Struct({ link: Link });

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

/** An API key pinned to `organization`, deleted with the scenario. */
const organizationKey = (organization: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const actors = yield* Actors;
    const created = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
      name: "File transfer",
      metadata: { organization },
    });
    expect(created.status).toBe(200);
    const key = yield* body(Key, created);
    yield* Effect.addFinalizer(() =>
      api
        .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
        .pipe(Effect.orDie),
    );
    return Redacted.value(key.key);
  });

/** The user-content folder of an organization's owner, under the server's data directory. */
const folderOf = (organization: string) =>
  Effect.map(
    Target,
    (target) => `${target.directory}/data/user-content/organization%3A${organization}`,
  );
const objectsIn = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.exists(folder)) ? (yield* fs.readDirectory(folder)).sort() : [];
  });

interface Raw {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
}
/** One HTTP request with exact control of its headers and body, and the answer's raw bytes. */
const raw = (
  method: "GET" | "HEAD" | "PUT" | "POST",
  url: string,
  options: {
    readonly headers?: Record<string, string>;
    readonly body?: Uint8Array;
    readonly stream?: Stream.Stream<Uint8Array>;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const target = yield* Target;
      // A path is this host's; a link is already a whole URL.
      let request = HttpClientRequest.make(method)(new URL(url, target.metadata.origin), {
        headers: options.headers ?? {},
      });
      if (options.body !== undefined)
        request = HttpClientRequest.bodyUint8Array(
          request,
          options.body,
          options.headers?.["content-type"],
        );
      if (options.stream !== undefined)
        request = HttpClientRequest.bodyStream(request, options.stream, {
          contentType: options.headers?.["content-type"] ?? "application/octet-stream",
        });
      const response = yield* client.execute(request);
      return {
        status: response.status,
        headers: response.headers,
        bytes: new Uint8Array(yield* response.arrayBuffer),
      } satisfies Raw;
    }),
  ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));

const json = <A>(schema: Schema.ConstraintDecoder<A, never>, response: Raw) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
    new TextDecoder().decode(response.bytes),
  );
const failureOf = (response: Raw) => json(Failure, response);
/** The handle an upload answered with, once it answered that it stored the file. */
const handleOf = (response: Raw) =>
  Effect.gen(function* () {
    expect(response.status, new TextDecoder().decode(response.bytes.slice(0, 300))).toBe(201);
    return yield* json(Handle, response);
  });
const same = (actual: Uint8Array, expected: Uint8Array) =>
  expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected))).toBe(0);

/**
 * The real `executor files` CLI as a child process with its own home, whose only credentials are
 * `env`.
 */
const filesCli = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const evidence = yield* Evidence;
    const entry = path.resolve(
      process.env.EXECUTOR_E2E_LOCAL_ENTRY ?? "apps/local/server/src/bin.ts",
    );
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "executor-files-cli-" });
    const run = (args: readonly string[]) =>
      evidence.step(
        `executor files ${args.join(" ")}`,
        Effect.scoped(
          Effect.gen(function* () {
            const command = localEntryCommand(entry, ["files", ...args]);
            const child = yield* processes.spawn(
              ChildProcess.make(command.command, command.args, {
                cwd: home,
                extendEnv: false,
                env: { PATH: process.env.PATH ?? "", HOME: home, DO_NOT_TRACK: "1", ...env },
                stdout: "pipe",
                stderr: "pipe",
                forceKillAfter: "3 seconds",
              }),
            );
            const [code, stdout, stderr] = yield* Effect.all(
              [
                child.exitCode,
                child.stdout.pipe(Stream.runCollect),
                child.stderr.pipe(Stream.decodeText(), Stream.mkString),
              ],
              { concurrency: 3 },
            ).pipe(Effect.timeout("120 seconds"));
            const output = Uint8Array.from(stdout.flatMap((chunk) => [...chunk]));
            return {
              code: Number(code),
              stdout: output,
              text: new TextDecoder().decode(output),
              stderr,
            };
          }),
        ),
      );
    return { home, run };
  });
const Saved = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    path: Schema.String,
    size: Schema.Number,
    sha256: Schema.String,
  }),
);
const Refused = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      code: Schema.String,
      status: Schema.optional(Schema.Number),
      message: Schema.String,
    }),
  }),
);

layer(HostedLive, { excludeTestServices: true })("File transfer", (it) => {
  it.effect(scenarios.fileDownloadRanges.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const target = yield* Target;
        const upstream = yield* blobUpstream;
        const organization = yield* createOrganization("Files ranges");
        const app = yield* blobApp(actors.owner, organization.id);
        const key = yield* organizationKey(organization.id);
        const prefix = `/api/organizations/${organization.id}`;
        const large = files.large.bytes;
        const size = large.length;
        const captured = yield* app.capture("capture", { url: upstream.url("blob", "large") });
        const sha = sha256Hex(large);
        const etag = `"sha256-${sha}"`;

        // A link is minted by an authenticated caller, or by an app through ctx.blobs.url.
        const mint = (expiresInSeconds?: number, filename?: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/files/${captured.handle.id}/download-url`,
              {
                ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
                ...(filename === undefined ? {} : { filename }),
              },
            );
            expect(response.status).toBe(200);
            return yield* body(Link, response);
          });
        const viaApi = yield* mint(600, "large.bin");
        const viaApp = (yield* Schema.decodeUnknownEffect(LinkResult)(
          (yield* app.call("link", { id: captured.handle.id, filename: "from app.bin" })).value,
        )).link;
        // The link points at this host, and nothing about the request names a credential.
        for (const link of [viaApi, viaApp]) {
          expect(new URL(link.url).origin).toBe(target.metadata.origin);
          expect(new URL(link.url).pathname).toMatch(/^\/api\/file-links\/[\w-]+\.[\w-]+$/u);
        }
        expect(viaApi.url).not.toBe(viaApp.url);

        // Lifetimes are clamped: at least a minute, at most a day, fifteen minutes by default.
        const lifetimes = yield* Effect.all([mint(1), mint(60), mint(1_000_000_000), mint(86_400)]);
        const at = (link: typeof Link.Type) => Date.parse(link.expiresAt);
        expect(Math.abs(at(lifetimes[0]) - at(lifetimes[1]))).toBeLessThan(5_000);
        expect(Math.abs(at(lifetimes[2]) - at(lifetimes[3]))).toBeLessThan(5_000);
        expect(Math.abs(at(yield* mint()) - at(lifetimes[1]) - 14 * 60_000)).toBeLessThan(10_000);

        // The whole file, with the headers that keep it a download and keep it ranged.
        const whole = yield* raw("GET", viaApi.url);
        expect(
          whole.status,
          `${viaApi.url} ${JSON.stringify(whole.headers)} ${new TextDecoder().decode(whole.bytes.slice(0, 300))}`,
        ).toBe(200);
        same(whole.bytes, large);
        expect(whole.headers["content-type"]).toBe("application/x-fixture");
        expect(whole.headers.etag).toBe(etag);
        expect(whole.headers["accept-ranges"]).toBe("bytes");
        expect(whole.headers["content-disposition"]).toBe("attachment; filename*=UTF-8''large.bin");
        expect(whole.headers["x-content-type-options"]).toBe("nosniff");
        expect(whole.headers["content-security-policy"]).toBe("sandbox");
        expect(whole.headers["cache-control"]).toBe("private, no-store, no-transform");
        expect(whole.headers["access-control-allow-origin"]).toBeUndefined();
        const named = yield* raw("GET", viaApp.url);
        expect(named.headers["content-disposition"]).toBe(
          "attachment; filename*=UTF-8''from%20app.bin",
        );
        same(named.bytes, large);

        // Exact ranges: the start, across a megabyte boundary, open-ended, and a suffix.
        const range = (header: string, link = viaApi) =>
          raw("GET", link.url, { headers: { range: header } });
        for (const [header, start, end] of [
          ["bytes=0-99", 0, 99],
          [`bytes=${mebibyte - 5}-${mebibyte + 5}`, mebibyte - 5, mebibyte + 5],
          [`bytes=${size - 300}-`, size - 300, size - 1],
          ["bytes=-500", size - 500, size - 1],
          [`bytes=${size - 10}-${size + 1_000_000}`, size - 10, size - 1],
        ] as const) {
          const part = yield* range(header);
          expect(part.status, header).toBe(206);
          expect(part.headers["content-range"], header).toBe(`bytes ${start}-${end}/${size}`);
          same(part.bytes, large.slice(start, end + 1));
        }
        // The app's link serves the same ranges.
        same((yield* range("bytes=1000-1999", viaApp)).bytes, large.slice(1000, 2000));
        // A range past the end is unsatisfiable, and says how long the file is.
        const beyond = yield* range(`bytes=${size}-`);
        expect(beyond.status).toBe(416);
        expect(beyond.headers["content-range"]).toBe(`bytes */${size}`);
        // Ranges this host does not serve, and one whose validator no longer matches, get the file.
        const multiple = yield* range("bytes=0-1,5-6");
        expect(multiple.status).toBe(200);
        same(multiple.bytes, large);
        const stale = yield* raw("GET", viaApi.url, {
          headers: { range: "bytes=0-9", "if-range": '"sha256-stale"' },
        });
        expect(stale.status).toBe(200);
        expect(stale.bytes.length).toBe(size);
        const current = yield* raw("GET", viaApi.url, {
          headers: { range: "bytes=0-9", "if-range": etag },
        });
        expect(current.status).toBe(206);

        // A conditional request needs no bytes; a different validator gets them.
        const unchanged = yield* raw("GET", viaApi.url, { headers: { "if-none-match": etag } });
        expect(unchanged.status).toBe(304);
        expect(unchanged.bytes.length).toBe(0);
        expect(unchanged.headers.etag).toBe(etag);
        expect(
          (yield* raw("GET", viaApi.url, { headers: { "if-none-match": '"other"' } })).status,
        ).toBe(200);
        // HEAD answers with the headers a GET would, and no body.
        const head = yield* raw("HEAD", viaApi.url);
        expect(head.status).toBe(200);
        expect(head.headers["content-length"]).toBe(String(size));
        expect(head.headers.etag).toBe(etag);
        expect(head.bytes.length).toBe(0);

        // The same serving code answers an authenticated caller, who needs no link.
        const authorization = { authorization: `Bearer ${key}` };
        const authenticated = yield* raw("GET", `${prefix}/files/${captured.handle.id}`, {
          headers: { ...authorization, range: "bytes=2097152-2097251" },
        });
        expect(authenticated.status).toBe(206);
        same(authenticated.bytes, large.slice(2097152, 2097252));
        expect(authenticated.headers["cache-control"]).toBe("private, no-store, no-transform");
        expect(authenticated.headers["content-disposition"]).toContain("attachment");
        expect(
          (yield* raw("GET", `${prefix}/files/${captured.handle.id}`)).status,
          "An unauthenticated request reaches no file",
        ).toBe(401);
        expect(
          (yield* raw("GET", `${prefix}/files/${captured.handle.id}x`, { headers: authorization }))
            .status,
        ).toBe(404);

        // A text file is not compressed, so its Range and length stay exact for any client.
        const text = "line of text, repeated\n".repeat(200);
        const note = yield* app.capture("captureText", { text, contentType: "text/plain" });
        const noteLink = yield* body(
          Link,
          yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/files/${note.handle.id}/download-url`,
            {},
          ),
        );
        const encoded = yield* raw("GET", noteLink.url, {
          headers: { "accept-encoding": "gzip, br" },
        });
        expect(encoded.headers["content-encoding"]).toBeUndefined();
        expect(encoded.headers["accept-ranges"]).toBe("bytes");
        expect(new TextDecoder().decode(encoded.bytes)).toBe(text);
        expect(encoded.headers["content-type"]).toBe("text/plain");

        // A handle another organization holds is not this one's to link.
        const other = yield* createOrganization("Files ranges other");
        const crossed = yield* api.request(
          actors.owner,
          "POST",
          `/api/organizations/${other.id}/files/${captured.handle.id}/download-url`,
          {},
        );
        expect(crossed.status).toBe(404);
      }),
    ),
  );

  it.effect(scenarios.fileLinkRejection.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const upstream = yield* blobUpstream;
        const organization = yield* createOrganization("Files links");
        const app = yield* blobApp(actors.owner, organization.id);
        const prefix = `/api/organizations/${organization.id}`;
        const captured = yield* app.capture("capture", { url: upstream.url("blob", "small") });
        const small = files.small.bytes;
        const mint = (id: string, payload: object = {}, as = actors.owner) =>
          api.request(as, "POST", `${prefix}/files/${id}/download-url`, payload);
        const good = yield* body(Link, yield* mint(captured.handle.id));
        expect((yield* raw("GET", good.url)).status).toBe(200);

        // Tampering with the payload or the signature, or presenting no token, grants nothing.
        const token = new URL(good.url).pathname.split("/").pop() ?? "";
        const [payload = "", mac = ""] = token.split(".");
        const flip = (text: string) =>
          `${text.slice(0, -3)}${text.at(-3) === "A" ? "B" : "A"}${text.slice(-2)}`;
        const at = (value: string) => new URL(`/api/file-links/${value}`, good.url).href;
        for (const forged of [
          `${flip(payload)}.${mac}`,
          `${payload}.${flip(mac)}`,
          payload,
          `${payload}.${mac}.extra`,
          `.${mac}`,
          "not-a-token",
        ]) {
          const refused = yield* raw("GET", at(forged));
          expect(refused.status, forged).toBe(403);
          expect((yield* failureOf(refused))._tag).toBe("FileLinkInvalid");
        }

        // An upload link cannot download, and a download link cannot upload.
        const upload = yield* body(
          Link,
          yield* api.request(actors.owner, "POST", `${prefix}/files/upload-url`, {}),
        );
        const wrongGet = yield* raw("GET", upload.url);
        expect(wrongGet.status).toBe(403);
        expect((yield* failureOf(wrongGet))._tag).toBe("FileLinkInvalid");
        const wrongPut = yield* raw("PUT", good.url, { body: new Uint8Array([1, 2, 3]) });
        expect(wrongPut.status).toBe(403);
        expect((yield* raw("POST", good.url, { body: new Uint8Array() })).status).toBe(405);

        // The link names the file, not a way into the organization's other files.
        const second = yield* app.capture("capture", { url: upstream.url("blob", "other") });
        const forgedId = yield* mint(second.handle.id);
        expect(forgedId.status).toBe(200);
        same((yield* raw("GET", good.url)).bytes, small);

        // A handle another organization holds is not this organization's to link, however it is asked.
        const other = yield* createOrganization("Files links other");
        const crossed = yield* api.request(
          actors.owner,
          "POST",
          `/api/organizations/${other.id}/files/${captured.handle.id}/download-url`,
          {},
        );
        expect(crossed.status).toBe(404);
        expect((yield* body(Failure, crossed))._tag).toBe("FileNotFound");
        expect((yield* mint("not-a-handle")).status).toBe(404);

        // A member who minted a link loses it when they leave the organization, at once.
        const { user } = yield* body(
          SessionIdentity,
          yield* api.request(actors.admin, "GET", "/api/auth/get-session"),
        );
        const invited = yield* api.request(
          actors.owner,
          "POST",
          "/api/auth/organization/invite-member",
          { organizationId: organization.id, email: user.email, role: "member", resend: true },
        );
        expect(invited.status).toBe(200);
        expect(
          (yield* api.request(actors.admin, "POST", "/api/auth/organization/accept-invitation", {
            invitationId: (yield* body(Resource, invited)).id,
          })).status,
        ).toBe(200);
        const members = yield* body(Link, yield* mint(captured.handle.id, {}, actors.admin));
        expect((yield* raw("GET", members.url)).status).toBe(200);
        expect(
          (yield* api.request(actors.owner, "POST", "/api/auth/organization/remove-member", {
            organizationId: organization.id,
            memberIdOrEmail: user.email,
          })).status,
        ).toBe(200);
        const removed = yield* raw("GET", members.url);
        expect(removed.status).toBe(403);
        expect((yield* failureOf(removed))._tag).toBe("FileLinkInvalid");
        // The owner's own links are untouched.
        expect((yield* raw("GET", good.url)).status).toBe(200);

        // A file the app deleted is gone for every link to it.
        yield* app.call("remove", { id: captured.handle.id });
        const retired = yield* raw("GET", good.url);
        expect(retired.status).toBe(404);
        expect((yield* failureOf(retired))._tag).toBe("BlobNotFound");

        // A link stops working when its lifetime ends. The shortest a link lives is a minute, so
        // the product's clock moves past it.
        const brief = yield* body(Link, yield* mint(second.handle.id, { expiresInSeconds: 60 }));
        expect((yield* raw("GET", brief.url)).status).toBe(200);
        yield* serverControl("clock/advance", 200, { milliseconds: 2 * 60_000 });
        const expired = yield* raw("GET", brief.url);
        expect(expired.status).toBe(410);
        expect((yield* failureOf(expired))._tag).toBe("FileLinkExpired");
        // A link made for longer outlives that jump.
        expect(
          (yield* raw("GET", (yield* body(Link, yield* mint(second.handle.id))).url)).status,
        ).toBe(200);
      }),
    ),
  );

  it.effect(scenarios.fileUpload.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const organization = yield* createOrganization("Files upload");
        const app = yield* blobApp(actors.owner, organization.id);
        const key = yield* organizationKey(organization.id);
        const folder = yield* folderOf(organization.id);
        const prefix = `/api/organizations/${organization.id}`;
        const authorization = { authorization: `Bearer ${key}` };
        const bytes = generatedBytes(21, mebibyte + 12345);

        // The organization's credential stores a file and gets its handle.
        const stored = yield* raw("PUT", `${prefix}/files`, {
          headers: { ...authorization, "content-type": "application/x-upload" },
          body: bytes,
        });
        expect(stored.status).toBe(201);
        const handle = yield* handleOf(stored);
        expect(handle).toMatchObject({
          size: bytes.length,
          sha256: sha256Hex(bytes),
          contentType: "application/x-upload",
        });
        expect(Date.parse(handle.expiresAt)).toBeGreaterThan(Date.now() - 86_400_000);
        expect(yield* objectsIn(folder)).toEqual([handle.id]);
        // It reads back whole, and an app in the organization sees the same handle.
        const back = yield* raw("GET", `${prefix}/files/${handle.id}`, { headers: authorization });
        same(back.bytes, bytes);
        expect(back.headers["content-type"]).toBe("application/x-upload");
        expect((yield* app.call("stat", { id: handle.id })).value).toMatchObject({
          handle: { id: handle.id, sha256: handle.sha256, size: bytes.length },
        });
        // The same bytes again are the same file, and no second object is stored.
        const again = yield* raw("PUT", `${prefix}/files`, {
          headers: { ...authorization, "x-executor-content-type": "application/x-upload" },
          body: bytes,
        });
        expect((yield* handleOf(again)).id).toBe(handle.id);
        expect(yield* objectsIn(folder)).toEqual([handle.id]);
        // An empty file is a file.
        const empty = yield* handleOf(
          yield* raw("PUT", `${prefix}/files`, { headers: authorization, body: new Uint8Array(0) }),
        );
        expect(empty).toMatchObject({ size: 0, sha256: sha256Hex(new Uint8Array(0)) });
        expect(yield* objectsIn(folder)).toEqual([empty.id, handle.id].sort());

        // Nobody else may store here: no credential, or a key pinned to another organization.
        expect([401, 403], "An upload without a credential stores nothing").toContain(
          (yield* raw("PUT", `${prefix}/files`, { body: new Uint8Array([1]) })).status,
        );
        const otherOrganization = yield* createOrganization("Files upload other");
        const otherKey = yield* organizationKey(otherOrganization.id);
        expect([401, 403], "A key pinned to another organization stores nothing").toContain(
          (yield* raw("PUT", `${prefix}/files`, {
            headers: { authorization: `Bearer ${otherKey}` },
            body: new Uint8Array([1]),
          })).status,
        );
        // A body of unknown length is stored by a host that can stream it, as the same file, and
        // refused before it is read by one whose store needs the size up front.
        const chunked = yield* raw("PUT", `${prefix}/files`, {
          headers: authorization,
          stream: Stream.fromIterable(
            Array.from({ length: Math.ceil(bytes.length / 65536) }, (_, at) =>
              bytes.slice(at * 65536, (at + 1) * 65536),
            ),
          ),
        });
        expect([201, 411]).toContain(chunked.status);
        if (chunked.status === 201) expect((yield* handleOf(chunked)).id).toBe(handle.id);
        else expect((yield* failureOf(chunked))._tag).toBe("FileLengthRequired");
        expect(yield* objectsIn(folder)).toEqual([empty.id, handle.id].sort());

        // An upload link stores a file with no credential, as the type and within the size it fixes.
        const link = yield* body(
          Link,
          yield* api.request(actors.owner, "POST", `${prefix}/files/upload-url`, {
            contentType: "text/x-note",
            maxBytes: 4096,
            expiresInSeconds: 600,
          }),
        );
        const note = new TextEncoder().encode("a note ".repeat(100));
        const uploaded = yield* raw("PUT", link.url, {
          headers: { "content-type": "application/octet-stream" },
          body: note,
        });
        expect(uploaded.status).toBe(201);
        const noted = yield* handleOf(uploaded);
        expect(noted).toMatchObject({
          size: note.length,
          sha256: sha256Hex(note),
          contentType: "text/x-note",
        });
        // The link takes more than one upload, and the same bytes are still one file.
        expect((yield* handleOf(yield* raw("PUT", link.url, { body: note }))).id).toBe(noted.id);
        const before = yield* objectsIn(folder);
        expect(before).toEqual([empty.id, handle.id, noted.id].sort());
        // Over its limit, an upload is refused with the limit, before anything is stored.
        const oversize = yield* raw("PUT", link.url, { body: new Uint8Array(4097).fill(7) });
        expect(oversize.status).toBe(413);
        expect(
          yield* json(Schema.Struct({ _tag: Schema.String, maximum: Schema.Number }), oversize),
        ).toMatchObject({ _tag: "BlobTooLarge", maximum: 4096 });
        expect(yield* objectsIn(folder)).toEqual(before);
        // The upload link cannot read anything back.
        expect((yield* raw("GET", link.url)).status).toBe(403);
        // A link that asks for more than the host stores gets the host's limit.
        const generous = yield* body(
          Link,
          yield* api.request(actors.owner, "POST", `${prefix}/files/upload-url`, {
            maxBytes: 1_000_000_000_000,
          }),
        );
        expect((yield* raw("PUT", generous.url, { body: note })).status).toBe(201);
      }),
    ),
  );

  it.effect(scenarios.fileCliRoundTrip.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const target = yield* Target;
        const organization = yield* createOrganization("Files CLI");
        const key = yield* organizationKey(organization.id);
        const { home, run } = yield* filesCli({ EXECUTOR_ACCESS_TOKEN: key });
        const connection = ["--host", target.metadata.origin, "--organization", organization.id];
        const bytes = generatedBytes(31, 2 * mebibyte + 777);
        const source = path.join(home, "in.bin");
        yield* fs.writeFile(source, bytes);
        const sha = sha256Hex(bytes);

        // Put prints the handle; the same bytes again print the same handle.
        const put = yield* run([
          "put",
          source,
          "--content-type",
          "application/x-cli",
          ...connection,
        ]);
        expect(put.code, put.stderr).toBe(0);
        const handle = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Handle))(put.text);
        expect(handle).toMatchObject({
          size: bytes.length,
          sha256: sha,
          contentType: "application/x-cli",
        });
        const repeat = yield* run(["put", source, ...connection]);
        expect(
          (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Handle))(repeat.text)).id,
        ).toBe(handle.id);

        // Get saves the bytes, verified against the file's own checksum.
        const output = path.join(home, "out.bin");
        const got = yield* run(["get", handle.id, "--output", output, ...connection]);
        expect(got.code, got.stderr).toBe(0);
        expect(yield* Schema.decodeUnknownEffect(Saved)(got.text)).toMatchObject({
          id: handle.id,
          size: bytes.length,
          sha256: sha,
        });
        same(yield* fs.readFile(output), bytes);
        // Without --output the bytes go to stdout, when a program reads it.
        const piped = yield* run(["get", handle.id, ...connection]);
        expect(piped.code, piped.stderr).toBe(0);
        same(piped.stdout, bytes);

        // An existing output is not overwritten without --resume.
        const exists = yield* run(["get", handle.id, "--output", output, ...connection]);
        expect(exists.code).toBe(1);
        expect((yield* Schema.decodeUnknownEffect(Refused)(exists.text)).error.code).toBe(
          "FilesFailed",
        );
        // An interrupted download resumes where it stopped and ends complete.
        const partial = path.join(home, "partial.bin");
        yield* fs.writeFile(partial, bytes.slice(0, 700_001));
        const resumed = yield* run([
          "get",
          handle.id,
          "--output",
          partial,
          "--resume",
          ...connection,
        ]);
        expect(resumed.code, resumed.stderr).toBe(0);
        same(yield* fs.readFile(partial), bytes);
        // A partial file that is already whole is verified, not downloaded again.
        const finished = yield* run([
          "get",
          handle.id,
          "--output",
          partial,
          "--resume",
          ...connection,
        ]);
        expect(finished.code, finished.stderr).toBe(0);
        expect((yield* Schema.decodeUnknownEffect(Saved)(finished.text)).sha256).toBe(sha);
        // A partial file that is not a prefix of the file is caught by the checksum.
        const corrupt = path.join(home, "corrupt.bin");
        yield* fs.writeFile(
          corrupt,
          Uint8Array.from(bytes.slice(0, 700_001), (byte, at) => (at === 5 ? byte ^ 0xff : byte)),
        );
        const refused = yield* run([
          "get",
          handle.id,
          "--output",
          corrupt,
          "--resume",
          ...connection,
        ]);
        expect(refused.code).toBe(1);
        expect((yield* Schema.decodeUnknownEffect(Refused)(refused.text)).error.code).toBe(
          "FilesFailed",
        );
        // The host's own error reaches the caller with its code and status.
        const missing = yield* run([
          "get",
          "not-a-handle",
          "--output",
          path.join(home, "missing.bin"),
          ...connection,
        ]);
        expect(missing.code).toBe(1);
        expect((yield* Schema.decodeUnknownEffect(Refused)(missing.text)).error).toMatchObject({
          code: "BlobNotFound",
          status: 404,
        });
        // Another organization's file is not reachable with this key.
        const unauthorized = yield* run([
          "get",
          handle.id,
          "--output",
          path.join(home, "other.bin"),
          "--host",
          target.metadata.origin,
          "--organization",
          randomUUID(),
        ]);
        expect(unauthorized.code).toBe(1);
      }),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("Local file transfer", (it) => {
  it.effect(scenarios.localFiles.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const key = Redacted.value(target.apiKey);
        const { home, run } = yield* filesCli({ EXECUTOR_API_KEY: key });
        const connection = ["--host", target.metadata.origin];
        const authorization = { authorization: `Bearer ${key}` };
        const bytes = generatedBytes(41, 1_500_000);
        const source = path.join(home, "in.bin");
        yield* fs.writeFile(source, bytes);

        // The CLI stores a file under the API key and reads it back, verified.
        const put = yield* run([
          "put",
          source,
          "--content-type",
          "application/x-local",
          ...connection,
        ]);
        expect(put.code, put.stderr).toBe(0);
        const handle = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Handle))(put.text);
        expect(handle).toMatchObject({
          size: bytes.length,
          sha256: sha256Hex(bytes),
          contentType: "application/x-local",
        });
        const output = path.join(home, "out.bin");
        const got = yield* run(["get", handle.id, "--output", output, ...connection]);
        expect(got.code, got.stderr).toBe(0);
        expect((yield* Schema.decodeUnknownEffect(Saved)(got.text)).sha256).toBe(handle.sha256);
        same(yield* fs.readFile(output), bytes);
        const partial = path.join(home, "partial.bin");
        yield* fs.writeFile(partial, bytes.slice(0, 400_000));
        expect(
          (yield* run(["get", handle.id, "--output", partial, "--resume", ...connection])).code,
        ).toBe(0);
        same(yield* fs.readFile(partial), bytes);

        // The API serves the file to its key only.
        const file = `/api/files/${handle.id}`;
        const read = yield* raw("GET", file, {
          headers: { ...authorization, range: "bytes=10-19" },
        });
        expect(read.status).toBe(206);
        same(read.bytes, bytes.slice(10, 20));
        expect([401, 403]).toContain((yield* raw("GET", file)).status);

        // A link carries that authority to a holder with no key: ranges, validators and uploads.
        const mint = (suffix: string, payload: object) =>
          Effect.gen(function* () {
            const response = yield* raw("POST", `/api/files/${suffix}`, {
              headers: { ...authorization, "content-type": "application/json" },
              body: new TextEncoder().encode(JSON.stringify(payload)),
            });
            expect(response.status, new TextDecoder().decode(response.bytes.slice(0, 300))).toBe(
              200,
            );
            return yield* json(Link, response);
          });
        // The link names this server's own address; its path is what the test reaches it by.
        const reach = (link: typeof Link.Type) => new URL(link.url).pathname;
        const download = yield* mint(`${handle.id}/download-url`, { filename: "local.bin" });
        const whole = yield* raw("GET", reach(download));
        expect(whole.status).toBe(200);
        same(whole.bytes, bytes);
        expect(whole.headers["content-disposition"]).toBe("attachment; filename*=UTF-8''local.bin");
        expect(whole.headers.etag).toBe(`"sha256-${handle.sha256}"`);
        const part = yield* raw("GET", reach(download), { headers: { range: "bytes=-100" } });
        expect(part.status).toBe(206);
        same(part.bytes, bytes.slice(-100));
        expect(
          (yield* raw("GET", reach(download), {
            headers: { "if-none-match": `"sha256-${handle.sha256}"` },
          })).status,
        ).toBe(304);
        expect((yield* raw("HEAD", reach(download))).headers.etag).toBe(
          `"sha256-${handle.sha256}"`,
        );
        const forged = `${reach(download)}x`;
        expect((yield* raw("GET", forged)).status).toBe(403);
        const upload = yield* mint("upload-url", { contentType: "text/x-local", maxBytes: 2048 });
        const note = new TextEncoder().encode("local note");
        const stored = yield* handleOf(yield* raw("PUT", reach(upload), { body: note }));
        expect(stored).toMatchObject({ size: note.length, contentType: "text/x-local" });
        expect((yield* raw("PUT", reach(upload), { body: new Uint8Array(2049) })).status).toBe(413);
        // What the link stored is the same file the CLI reads.
        const fetched = yield* run(["get", stored.id, ...connection]);
        expect(fetched.code, fetched.stderr).toBe(0);
        same(fetched.stdout, note);
      }),
    ),
  );
});
