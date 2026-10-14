/**
 * Apps keep files by handle: a tool returns a small reference, the host fetches and stores the
 * bytes itself, and nothing but that reference crosses the tool boundary.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { blobApp, type Handle } from "../support/blob-app.ts";
import { blobUpstream, files, hex, sha256Hex, stallMillis } from "../support/blob-upstream.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Organization } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const mebibyte = 1024 * 1024;
const hour = 60 * 60;
const day = 24 * hour;
const Settings = Schema.Struct({
  ttlSeconds: Schema.Number,
  defaultTtlSeconds: Schema.Number,
  minTtlSeconds: Schema.Number,
  maxTtlSeconds: Schema.Number,
  canEdit: Schema.Boolean,
});
const Hex = Schema.Struct({ length: Schema.Number, hex: Schema.String });
const Digest = Schema.Struct({ length: Schema.Number, sha256: Schema.String });
const Limits = Schema.Struct({
  maxFileBytes: Schema.Number,
  maxInlineBytes: Schema.Number,
  maxReadBytes: Schema.Number,
  methods: Schema.Array(Schema.String),
  ttlSeconds: Schema.Number,
});

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

/** The user-content folder of an organization's owner, under the server's data directory. */
const folderOf = (organization: string) =>
  Effect.map(
    Target,
    (target) => `${target.directory}/data/user-content/organization%3A${organization}`,
  );

/** Every object under a folder; none when the folder does not exist yet. */
const objectsIn = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.exists(folder)) ? (yield* fs.readDirectory(folder)).sort() : [];
  });

layer(HostedLive, { excludeTestServices: true })("File handles", (it) => {
  it.effect(scenarios.appBlobHandles.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const target = yield* Target;
        const fs = yield* FileSystem.FileSystem;
        const upstream = yield* blobUpstream;
        const orgA = yield* createOrganization("Files A");
        const orgB = yield* createOrganization("Files B");
        const appA = yield* blobApp(actors.owner, orgA.id);
        const appA2 = yield* blobApp(actors.owner, orgA.id);
        const appB = yield* blobApp(actors.owner, orgB.id);
        const appDatabase = yield* blobApp(actors.owner, orgA.id, { database: true });
        const folderA = yield* folderOf(orgA.id);

        // What this host stores, and for how long.
        const limits = yield* Schema.decodeUnknownEffect(Limits)(
          (yield* appA.call("limits")).value,
        );
        expect(limits.maxFileBytes).toBe(2 * 1024 * mebibyte);
        expect(limits.methods).toEqual(["fromUrl", "create", "read"]);
        expect(limits.ttlSeconds).toBe(7 * day);

        // The host fetches the file; the tool result is a small handle, never the bytes.
        const large = files.large.bytes;
        const captured = yield* appA.capture("capture", { url: upstream.url("blob", "large") });
        expect(captured.size).toBeLessThan(1024);
        expect(captured.handle.size).toBe(large.length);
        expect(captured.handle.sha256).toBe(sha256Hex(large));
        expect(captured.handle.contentType).toBe("application/x-fixture");
        expect(Date.parse(captured.handle.expiresAt)).toBeGreaterThan(Date.now() - day);
        expect(yield* upstream.count("/blob/large")).toBe(1);

        // Exact ranges, including one across a 1 MiB boundary and one clamped at the end.
        const read = (handle: Handle, offset: number, length: number) =>
          Effect.gen(function* () {
            const { value } = yield* appA.call("slice", { handle, offset, length });
            return yield* Schema.decodeUnknownEffect(Hex)(value);
          });
        for (const [offset, length] of [
          [0, 4096],
          [mebibyte - 100, 300],
          [3_000_000, 5000],
        ] as const) {
          const slice = yield* read(captured.handle, offset, length);
          expect(slice.hex).toBe(hex(large.slice(offset, offset + length)));
        }
        const tail = yield* read(captured.handle, large.length - 50, 4096);
        expect(tail.length).toBe(50);
        expect(tail.hex).toBe(hex(large.slice(large.length - 50)));
        expect((yield* read(captured.handle, large.length + 10, 100)).length).toBe(0);
        // A whole megabyte in one call is the most a read returns; one byte more is refused.
        const whole = yield* Schema.decodeUnknownEffect(Digest)(
          (yield* appA.call("digest", { handle: captured.handle, offset: 0, length: mebibyte }))
            .value,
        );
        expect(whole.sha256).toBe(sha256Hex(large.slice(0, mebibyte)));
        expect(
          yield* appA.failure("slice", {
            handle: captured.handle,
            offset: 0,
            length: mebibyte + 1,
          }),
        ).toMatchObject({ _tag: "BlobRangeInvalid", maximum: mebibyte });
        // A handle whose bytes are not the ones stored is refused.
        expect(
          yield* appA.failure("slice", {
            handle: { ...captured.handle, sha256: "0".repeat(64) },
            offset: 0,
            length: 10,
          }),
        ).toMatchObject({ _tag: "BlobIntegrityError", reason: "handle" });

        // The same bytes in the same organization are one file, however they arrive: from a
        // server that sends no length, from another app, or as inline bytes.
        const chunked = yield* appA.capture("capture", { url: upstream.url("chunked", "large") });
        expect(chunked.handle.id).toBe(captured.handle.id);
        expect(Date.parse(chunked.handle.expiresAt)).toBeGreaterThanOrEqual(
          Date.parse(captured.handle.expiresAt),
        );
        const shared = yield* appA2.capture("capture", { url: upstream.url("blob", "large") });
        expect(shared.handle.id).toBe(captured.handle.id);
        const text = "inline file contents";
        const inline = yield* appA.capture("captureText", { text, contentType: "text/plain" });
        expect((yield* appA.capture("captureText", { text })).handle.id).toBe(inline.handle.id);
        expect(inline.handle.contentType).toBe("text/plain");
        expect(inline.handle.sha256).toBe(sha256Hex(new TextEncoder().encode(text)));
        // Redirects are followed hop by hop, and request headers reach the upstream.
        const redirected = yield* appA.capture("capture", {
          url: upstream.url("redirect", "small"),
          headers: { "x-fixture": "kept" },
        });
        expect(redirected.handle.sha256).toBe(sha256Hex(files.small.bytes));
        expect(
          (yield* upstream.received).find((entry) => entry.path === "/redirect/small")?.headers[
            "x-fixture"
          ],
        ).toBe("kept");

        // An app with a database runs in its data facet and keeps files the same way.
        const viaDatabase = yield* appDatabase.capture("capture", {
          url: upstream.url("blob", "small"),
        });
        expect(viaDatabase.handle.id).toBe(redirected.handle.id);
        const databaseTail = yield* Schema.decodeUnknownEffect(Hex)(
          (yield* appDatabase.call("slice", {
            handle: viaDatabase.handle,
            offset: files.small.bytes.length - 8,
            length: 100,
          })).value,
        );
        expect(databaseTail.hex).toBe(hex(files.small.bytes.slice(-8)));

        // Another organization cannot use the handle, and storing the same bytes there is its own file.
        expect(yield* appB.failure("stat", { id: captured.handle.id })).toMatchObject({
          _tag: "BlobNotFound",
        });
        expect(
          yield* appB.failure("slice", { handle: captured.handle, offset: 0, length: 10 }),
        ).toMatchObject({ _tag: "BlobNotFound" });
        const own = yield* appB.capture("capture", { url: upstream.url("blob", "large") });
        expect(own.handle.id).not.toBe(captured.handle.id);
        expect(own.handle.sha256).toBe(captured.handle.sha256);

        // On disk the file is one object under its organization's private folder.
        const stored = yield* objectsIn(folderA);
        expect(stored).toContain(captured.handle.id);
        expect(stored).toHaveLength(3);
        expect(((yield* fs.stat(folderA)).mode & 0o777).toString(8)).toBe("700");
        // Builds keep their own store: no file's bytes are kept there.
        expect(
          (yield* fs.readDirectory(`${target.directory}/data/builds`, { recursive: true })).filter(
            (entry) => entry.includes(captured.handle.id) || entry.includes(captured.handle.sha256),
          ),
        ).toEqual([]);

        // Failures leave nothing behind and say what went wrong.
        const before = yield* objectsIn(folderA);
        expect(yield* appA.failure("capture", { url: upstream.status(500) })).toMatchObject({
          _tag: "BlobUpstreamFailed",
          reason: "status",
          status: 500,
        });
        expect(
          yield* appA.failure("capture", { url: upstream.url("blob", "other"), expectedSize: 123 }),
        ).toMatchObject({ _tag: "BlobIntegrityError", reason: "size" });
        expect(
          yield* appA.failure("capture", {
            url: upstream.url("chunked", "other"),
            expectedSize: 123,
          }),
        ).toMatchObject({ _tag: "BlobIntegrityError", reason: "size" });
        expect(
          yield* appA.failure("capture", {
            url: upstream.url("blob", "other"),
            expectedSha256: "f".repeat(64),
          }),
        ).toMatchObject({ _tag: "BlobIntegrityError", reason: "sha256" });
        expect(
          yield* appA.failure("capture", {
            url: upstream.url("blob", "other"),
            expectedSize: 3 * 1024 * mebibyte,
          }),
        ).toMatchObject({ _tag: "BlobTooLarge", maximum: 2 * 1024 * mebibyte });
        expect(
          yield* appA.failure("captureBytes", { size: limits.maxInlineBytes + 1 }),
        ).toMatchObject({ _tag: "BlobTooLarge", maximum: limits.maxInlineBytes });
        expect(yield* appA.failure("capture", { url: "ftp://example.test/file" })).toMatchObject({
          _tag: "BlobUpstreamFailed",
          reason: "request",
        });
        const after = yield* objectsIn(folderA);
        expect(after, `before ${before.join()} after ${after.join()}`).toEqual(before);
        // The matching file passes the same checks.
        const verified = yield* appA.capture("capture", {
          url: upstream.url("blob", "other"),
          expectedSize: files.other.bytes.length,
          expectedSha256: sha256Hex(files.other.bytes),
        });
        expect(verified.handle.size).toBe(files.other.bytes.length);

        // Only the app that stored a file may delete it, and deleting removes it for the organization.
        expect(yield* appA2.failure("remove", { id: captured.handle.id })).toMatchObject({
          _tag: "BlobNotFound",
        });
        expect(yield* appA.call("stat", { id: captured.handle.id })).toBeDefined();
        yield* appA.call("remove", { id: captured.handle.id });
        expect(yield* appA.failure("stat", { id: captured.handle.id })).toMatchObject({
          _tag: "BlobNotFound",
        });
        expect(yield* objectsIn(folderA)).not.toContain(captured.handle.id);
        // Another organization's identical file is untouched.
        expect((yield* appB.call("stat", { id: own.handle.id })).value).toMatchObject({
          handle: { id: own.handle.id },
        });

        // The lifetime is an organization setting: owners and admins change it, members cannot.
        const settings = (organization: string, session = actors.owner) =>
          api.request(session, "GET", `/api/organizations/${organization}/blob-settings`);
        const save = (organization: string, ttlSeconds: number, session = actors.owner) =>
          api.request(session, "PUT", `/api/organizations/${organization}/blob-settings`, {
            ttlSeconds,
          });
        const defaults = yield* body(Settings, yield* settings(actors.organization.id));
        expect(defaults).toMatchObject({
          ttlSeconds: 7 * day,
          defaultTtlSeconds: 7 * day,
          minTtlSeconds: hour,
          maxTtlSeconds: 365 * day,
          canEdit: true,
        });
        expect(
          (yield* body(Settings, yield* settings(actors.organization.id, actors.member))).canEdit,
        ).toBe(false);
        expect((yield* save(actors.organization.id, 2 * day, actors.member)).status).toBe(403);
        expect((yield* save(actors.organization.id, 60)).status).toBe(400);
        expect((yield* save(actors.organization.id, 366 * day)).status).toBe(400);
        expect(
          (yield* body(Settings, yield* save(actors.organization.id, 2 * day, actors.admin)))
            .ttlSeconds,
        ).toBe(2 * day);
        expect((yield* save(actors.organization.id, 7 * day)).status).toBe(200);
        // A new file lives as long as its organization chose: two hours here, seven days before.
        const longer = yield* appA.capture("capture", {
          url: upstream.url("blob", "small"),
        });
        expect((yield* body(Settings, yield* save(orgA.id, 2 * hour))).ttlSeconds).toBe(2 * hour);
        const shorter = yield* appA.capture("captureText", { text: "short-lived" });
        const difference =
          Date.parse(longer.handle.expiresAt) - Date.parse(shorter.handle.expiresAt);
        expect(Math.abs(difference - (7 * day - 2 * hour) * 1000)).toBeLessThan(120_000);
      }),
    ),
  );

  it.effect(scenarios.appBlobHandleExpiry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const upstream = yield* blobUpstream;
        const organization = yield* createOrganization("Files expiry");
        const app = yield* blobApp(actors.owner, organization.id);
        const folder = yield* folderOf(organization.id);
        const save = (ttlSeconds: number) =>
          api.request(actors.owner, "PUT", `/api/organizations/${organization.id}/blob-settings`, {
            ttlSeconds,
          });
        // One file with the shortest lifetime, one that outlives the clock's jump.
        expect((yield* save(hour)).status).toBe(200);
        const short = yield* app.capture("capture", { url: upstream.url("blob", "small") });
        expect((yield* save(2 * day)).status).toBe(200);
        const long = yield* app.capture("capture", { url: upstream.url("blob", "other") });
        const lifetime = (handle: Handle) => Date.parse(handle.expiresAt) - Date.now();
        expect(lifetime(short.handle)).toBeLessThan(hour * 1000 + 60_000);
        expect(lifetime(long.handle)).toBeGreaterThan(day * 1000);
        expect(yield* objectsIn(folder)).toEqual([long.handle.id, short.handle.id].sort());

        // Two hours later the short file is denied to every reader as expired. The product sweeps
        // hourly here, so the object is certainly still stored: the denial is the lifetime's, not
        // the sweep's.
        yield* serverControl("clock/advance", 200, { milliseconds: 2 * hour * 1000 });
        expect(yield* app.failure("stat", { id: short.handle.id })).toMatchObject({
          _tag: "BlobExpired",
        });
        expect(
          yield* app.failure("slice", { handle: short.handle, offset: 0, length: 10 }),
        ).toMatchObject({ _tag: "BlobExpired" });
        expect(yield* objectsIn(folder)).toContain(short.handle.id);
        // An operator who sweeps every second restarts the product; its first sweep removes the
        // object, and the file then reads as missing. The long file is untouched throughout.
        yield* serverControl("stop");
        yield* serverControl("environment", 200, { EXECUTOR_FILE_HANDLE_SWEEP_SECONDS: "1" });
        yield* serverControl("start");
        yield* objectsIn(folder).pipe(
          Effect.filterOrFail(
            (objects) => !objects.includes(short.handle.id),
            () => "The expired file is still stored",
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
        );
        expect(yield* objectsIn(folder)).toEqual([long.handle.id]);
        const slice = yield* Schema.decodeUnknownEffect(Hex)(
          (yield* app.call("slice", { handle: long.handle, offset: 0, length: 256 })).value,
        );
        expect(slice.hex).toBe(hex(files.other.bytes.slice(0, 256)));
        expect(yield* app.failure("stat", { id: short.handle.id })).toMatchObject({
          _tag: "BlobNotFound",
        });
        // Storing the expired bytes again makes a new file.
        const again = yield* app.capture("capture", { url: upstream.url("blob", "small") });
        expect(again.handle.id).not.toBe(short.handle.id);
      }),
    ),
  );

  it.effect(scenarios.appBlobHandleTransfers.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const upstream = yield* blobUpstream;
        const actors = yield* Actors;
        const organization = yield* createOrganization("Files transfers");
        const app = yield* blobApp(actors.owner, organization.id);
        const folder = yield* folderOf(organization.id);

        // An empty file is a file: it is stored, hashed and read back as nothing.
        const empty = yield* app.capture("capture", { url: upstream.url("blob", "empty") });
        expect(empty.handle.size).toBe(0);
        expect(empty.handle.sha256).toBe(sha256Hex(new Uint8Array(0)));
        expect(
          (yield* app.call("slice", { handle: empty.handle, offset: 0, length: 16 })).value,
        ).toEqual({ length: 0, hex: "" });

        // Two transfers of the same bytes at once end on one handle and one stored object.
        const pair = yield* Effect.all(
          [
            app.capture("capture", { url: upstream.url("blob", "other") }),
            app.capture("capture", { url: upstream.url("blob", "other") }),
          ],
          { concurrency: "unbounded" },
        );
        expect(pair[0].handle.id).toBe(pair[1].handle.id);
        expect(yield* objectsIn(folder)).toEqual([empty.handle.id, pair[0].handle.id].sort());

        // The reservation outlives its lifetime while a stalled upstream keeps the transfer
        // running: here it lasts 6 seconds, the product sweeps every second and the upstream
        // pauses for 10, yet the file commits whole.
        expect(stallMillis).toBeGreaterThan(6_000);
        const stalled = yield* app.capture("capture", { url: upstream.url("stalled", "small") });
        expect(stalled.handle.size).toBe(files.small.bytes.length);
        expect(stalled.handle.sha256).toBe(sha256Hex(files.small.bytes));
        const digest = yield* Schema.decodeUnknownEffect(Digest)(
          (yield* app.call("digest", { handle: stalled.handle, offset: 0, length: mebibyte }))
            .value,
        );
        expect(digest.sha256).toBe(sha256Hex(files.small.bytes));
      }),
    ),
  );
});
