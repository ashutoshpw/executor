/**
 * The Files page lists the files an organization's apps keep, and the file routes honor the same
 * visibility. Owners and admins reach every complete file of the organization; a member reaches
 * the files of apps they can use, and none that no app created. Only owners and admins delete.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { blobApp } from "../support/blob-app.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Organization } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const Page = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      contentType: Schema.String,
      size: Schema.Number,
      sha256: Schema.String,
      createdAt: Schema.String,
      expiresAt: Schema.String,
      app: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) })),
    }),
  ),
  next: Schema.NullOr(Schema.String),
  apps: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  canDelete: Schema.Boolean,
});
const Entry = Schema.Struct({
  id: Schema.String,
  contentType: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  app: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) })),
});
const Link = Schema.Struct({ url: Schema.String, expiresAt: Schema.String });
const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const Failure = Schema.Struct({ _tag: Schema.String });
const Stored = Schema.Struct({ id: Schema.String });

/** A fresh organization owned by the scenario's owner, for the cross-organization checks. */
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

/** An API key of `session`'s user pinned to `organization`, deleted with the scenario. */
const keyFor = (session: Session, organization: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const created = yield* api.request(session, "POST", "/api/auth/api-key/create", {
      name: "Organization files",
      metadata: { organization },
    });
    expect(created.status).toBe(200);
    const key = yield* body(Key, created);
    yield* Effect.addFinalizer(() =>
      api
        .request(session, "POST", "/api/auth/api-key/delete", { keyId: key.id })
        .pipe(Effect.orDie),
    );
    return Redacted.value(key.key);
  });

/** One raw request against this host or a link: the status and the answer's bytes. */
const raw = (
  method: "GET" | "PUT",
  url: string,
  options: { readonly headers?: Record<string, string>; readonly body?: Uint8Array } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const target = yield* Target;
      let request = HttpClientRequest.make(method)(new URL(url, target.metadata.origin), {
        headers: options.headers ?? {},
      });
      if (options.body !== undefined)
        request = HttpClientRequest.bodyUint8Array(request, options.body);
      const response = yield* client.execute(request);
      return { status: response.status, bytes: new Uint8Array(yield* response.arrayBuffer) };
    }),
  ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));

/** A GET of a link with the answer's headers, for the checks on how a download is served. */
const fetchWithHeaders = (url: string, headers: Record<string, string> = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const target = yield* Target;
      const response = yield* client.execute(
        HttpClientRequest.get(new URL(url, target.metadata.origin), { headers }),
      );
      return {
        status: response.status,
        headers: response.headers,
        bytes: new Uint8Array(yield* response.arrayBuffer),
      };
    }),
  ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const tagOf = (response: { readonly body: unknown }) =>
  Effect.map(body(Failure, response as never), (failure) => failure._tag);

/** The user-content folder of an organization's owner, under the server's data directory. */
const folderOf = (organization: string) =>
  Effect.map(
    Target,
    (target) => `${target.directory}/data/user-content/organization%3A${organization}`,
  );

layer(HostedLive, { excludeTestServices: true })("Organization files", (it) => {
  it.effect(scenarios.organizationFiles.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const fs = yield* FileSystem.FileSystem;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const appA = yield* blobApp(actors.owner, organization);
        const appB = yield* blobApp(actors.owner, organization, { audience: "private" });
        const ownerKey = yield* keyFor(actors.owner, organization);
        const unique = randomUUID();
        const texts = {
          a1: `first file of A ${unique}`,
          b1: `file of the private app B ${unique}`,
          a2: `second file of A ${unique}`,
          upload: `uploaded over HTTP ${unique}`,
        };
        // Created in this order, so the listing shows them in the reverse.
        const a1 = (yield* appA.capture("captureText", { text: texts.a1, contentType: "text/x-a" }))
          .handle;
        const b1 = (yield* appB.capture("captureText", { text: texts.b1, contentType: "text/x-b" }))
          .handle;
        const a2 = (yield* appA.capture("captureText", { text: texts.a2 })).handle;
        const stored = yield* raw("PUT", `${prefix}/files`, {
          headers: {
            authorization: `Bearer ${ownerKey}`,
            "x-executor-content-type": "text/x-upload",
          },
          body: new TextEncoder().encode(texts.upload),
        });
        expect(stored.status).toBe(201);
        const upload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Stored))(
          text(stored.bytes),
        );
        const mine = new Set([a1.id, b1.id, a2.id, upload.id]);
        const newestFirst = [upload.id, a2.id, b1.id, a1.id];

        const list = (as: Session, query = "") => api.request(as, "GET", `${prefix}/files${query}`);
        /** Every page of a listing, one request per page, with the files that are this scenario's. */
        const everything = (as: Session, query = "", limit = 100) =>
          Effect.gen(function* () {
            const ids: string[] = [];
            let pages = 0;
            let after = null as string | null;
            let first: typeof Page.Type | undefined;
            do {
              const response = yield* list(
                as,
                `?limit=${limit}${query}${after === null ? "" : `&after=${encodeURIComponent(after)}`}`,
              );
              expect(response.status, JSON.stringify(response.body).slice(0, 300)).toBe(200);
              const page = yield* body(Page, response);
              first ??= page;
              ids.push(...page.files.map((file) => file.id));
              pages += 1;
              after = page.next;
            } while (after !== null && pages < 200);
            expect(new Set(ids).size, "no file is listed twice").toBe(ids.length);
            return { ids, mine: ids.filter((id) => mine.has(id)), pages, first: first! };
          });

        // The owner sees every file, newest first, with what the page shows about each.
        const owner = yield* everything(actors.owner);
        expect(owner.mine).toEqual(newestFirst);
        expect(owner.first.canDelete).toBe(true);
        expect(owner.first.apps.map((app) => app.id)).toEqual(
          expect.arrayContaining([appA.id, appB.id]),
        );
        const entries = new Map(
          (yield* body(Page, yield* list(actors.owner, "?limit=100"))).files.map((file) => [
            file.id,
            file,
          ]),
        );
        expect(entries.get(a1.id)).toMatchObject({
          contentType: "text/x-a",
          size: new TextEncoder().encode(texts.a1).length,
          sha256: a1.sha256,
          app: { id: appA.id, name: expect.any(String) },
        });
        expect(entries.get(b1.id)?.app?.id).toBe(appB.id);
        expect(entries.get(upload.id)).toMatchObject({ contentType: "text/x-upload", app: null });
        for (const entry of entries.values()) {
          expect(Date.parse(entry.createdAt)).toBeLessThanOrEqual(Date.parse(entry.expiresAt));
          expect(entry.expiresAt).toMatch(/Z$/u);
        }

        // An admin sees the same files, including those of an app they cannot use.
        const admin = yield* everything(actors.admin);
        expect(admin.mine).toEqual(newestFirst);
        expect(admin.first.canDelete).toBe(true);

        // A member sees the files of apps they can use, and no file without a creator app.
        const member = yield* everything(actors.member);
        expect(member.mine).toEqual([a2.id, a1.id]);
        expect(member.first.canDelete).toBe(false);
        expect(member.first.apps.map((app) => app.id)).toContain(appA.id);
        expect(member.first.apps.map((app) => app.id)).not.toContain(appB.id);
        // One file by handle answers with the entry the listing shows, under the same visibility.
        const details = (as: Session, id: string) =>
          api.request(as, "GET", `${prefix}/files/${id}/details`);
        for (const as of [actors.owner, actors.admin])
          expect(yield* body(Entry, yield* details(as, a1.id))).toEqual(entries.get(a1.id));
        expect(yield* body(Entry, yield* details(actors.owner, upload.id))).toEqual(
          entries.get(upload.id),
        );
        expect(yield* body(Entry, yield* details(actors.member, a1.id))).toEqual(
          entries.get(a1.id),
        );
        const unknownFile = yield* details(actors.member, "00000000-0000-4000-8000-000000000000");
        expect(unknownFile.status).toBe(404);
        expect(yield* tagOf(unknownFile)).toBe("FileNotFound");
        // A file of an app the member cannot use, and one no app created, read as missing.
        for (const id of [b1.id, upload.id]) {
          const hiddenFile = yield* details(actors.member, id);
          expect(hiddenFile.status, `a member reads ${id}`).toBe(404);
          expect(hiddenFile.body).toEqual(unknownFile.body);
        }
        // A filter on an app they cannot use is empty, as it is for an app that does not exist.
        const hidden = yield* body(
          Page,
          yield* list(actors.member, `?app=${encodeURIComponent(appB.id)}`),
        );
        expect(hidden.files).toEqual([]);
        expect(hidden.next).toBeNull();
        const missing = yield* body(Page, yield* list(actors.member, "?app=app_missing"));
        expect(missing.files).toEqual([]);
        // The owner's filter narrows to one app.
        const onlyA = yield* body(
          Page,
          yield* list(actors.owner, `?limit=100&app=${encodeURIComponent(appA.id)}`),
        );
        expect(onlyA.files.length).toBeGreaterThanOrEqual(2);
        expect(onlyA.files.every((file) => file.app?.id === appA.id)).toBe(true);

        // Pages of one follow each other without gaps or repeats, and a bad cursor is refused.
        const paged = yield* everything(actors.owner, "", 1);
        expect(paged.mine).toEqual(newestFirst);
        expect(paged.pages).toBe(paged.ids.length);
        expect(owner.ids).toEqual(paged.ids);
        const garbage = [
          "not-a-cursor",
          Buffer.from("{}").toString("base64url"),
          Buffer.from(JSON.stringify({ t: "yesterday", i: "x" })).toString("base64url"),
          // Shaped like a timestamp but not one Postgres accepts.
          Buffer.from(JSON.stringify({ t: "2026-99-99 00:00:00", i: "x" })).toString("base64url"),
          Buffer.from(JSON.stringify({ t: "2026-02-30 00:00:00", i: "x" })).toString("base64url"),
          Buffer.from(JSON.stringify({ t: "2026-01-01 25:00:00", i: "x" })).toString("base64url"),
          Buffer.from(JSON.stringify({ t: "2026-01-01 00:00:00+99", i: "x" })).toString(
            "base64url",
          ),
        ];
        for (const after of garbage) {
          const refused = yield* list(actors.owner, `?after=${encodeURIComponent(after)}`);
          expect(refused.status, after).toBe(400);
          expect(yield* tagOf(refused)).toBe("FilesCursorInvalid");
        }
        expect((yield* list(actors.owner, "?limit=0")).status).toBe(400);
        expect((yield* list(actors.owner, "?limit=101")).status).toBe(400);

        // Another organization has its own files, and a non-member cannot list this one's.
        const other = yield* createOrganization("Files other");
        const otherList = yield* api.request(
          actors.owner,
          "GET",
          `/api/organizations/${other.id}/files`,
        );
        expect((yield* body(Page, otherList)).files).toEqual([]);
        expect(
          (yield* api.request(actors.member, "GET", `/api/organizations/${other.id}/files`)).status,
        ).toBe(403);

        // Members cannot delete, even a file of an app they use; the file stays readable.
        const refused = yield* api.request(actors.member, "DELETE", `${prefix}/files/${a1.id}`);
        expect(refused.status).toBe(403);
        expect(yield* tagOf(refused)).toBe("OrganizationForbidden");
        expect((yield* appA.call("stat", { id: a1.id })).value).toMatchObject({
          handle: { id: a1.id },
        });
        // An app still deletes only what it stored: app A cannot remove app B's file.
        expect((yield* appA.failure("remove", { id: b1.id }))._tag).toBe("BlobNotFound");

        // An admin deletes any file, including an app's they cannot use. The app can no longer
        // read it and its object is removed.
        const folder = yield* folderOf(organization);
        expect(yield* fs.readDirectory(folder)).toContain(b1.id);
        expect(
          (yield* api.request(actors.admin, "DELETE", `${prefix}/files/${b1.id}`)).status,
        ).toBe(204);
        expect((yield* appB.failure("stat", { id: b1.id }))._tag).toBe("BlobNotFound");
        expect(yield* fs.readDirectory(folder)).not.toContain(b1.id);
        expect((yield* everything(actors.owner)).mine).toEqual([upload.id, a2.id, a1.id]);
        const again = yield* api.request(actors.admin, "DELETE", `${prefix}/files/${b1.id}`);
        expect(again.status).toBe(404);
        expect(yield* tagOf(again)).toBe("FileNotFound");
        // An owner deletes a file that no app created, and another organization's id is unknown.
        expect(
          (yield* api.request(actors.owner, "DELETE", `${prefix}/files/${upload.id}`)).status,
        ).toBe(204);
        expect(
          (yield* api.request(
            actors.owner,
            "DELETE",
            `/api/organizations/${other.id}/files/${a1.id}`,
          )).status,
        ).toBe(404);
        // Clean up what this scenario kept in the shared organization.
        for (const id of [a1.id, a2.id])
          expect((yield* api.request(actors.owner, "DELETE", `${prefix}/files/${id}`)).status).toBe(
            204,
          );
        expect((yield* everything(actors.owner)).mine).toEqual([]);
      }),
    ),
  );

  it.effect(scenarios.organizationFileDownloads.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const appA = yield* blobApp(actors.owner, organization);
        const appB = yield* blobApp(actors.owner, organization, { audience: "private" });
        const ownerKey = yield* keyFor(actors.owner, organization);
        const memberKey = yield* keyFor(actors.member, organization);
        const unique = randomUUID();
        const content = {
          a: `file of A ${unique}`,
          b: `file of private B ${unique}`,
          upload: `file without an app ${unique}`,
        };
        const a = (yield* appA.capture("captureText", { text: content.a })).handle;
        const b = (yield* appB.capture("captureText", { text: content.b })).handle;
        const stored = yield* raw("PUT", `${prefix}/files`, {
          headers: { authorization: `Bearer ${ownerKey}` },
          body: new TextEncoder().encode(content.upload),
        });
        expect(stored.status).toBe(201);
        const upload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Stored))(
          text(stored.bytes),
        );
        // A file a member uploads has no creator app either, so the member cannot fetch it back:
        // this is the decided rule, administrators reach it.
        const memberStored = yield* raw("PUT", `${prefix}/files`, {
          headers: { authorization: `Bearer ${memberKey}` },
          body: new TextEncoder().encode(`member upload ${unique}`),
        });
        expect(memberStored.status).toBe(201);
        const memberUpload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Stored))(
          text(memberStored.bytes),
        );
        const files = [
          { id: memberUpload.id, text: `member upload ${unique}`, visibleToMember: false },
          { id: a.id, text: content.a, visibleToMember: true },
          { id: b.id, text: content.b, visibleToMember: false },
          { id: upload.id, text: content.upload, visibleToMember: false },
        ];
        const mint = (as: Session, id: string) =>
          api.request(as, "POST", `${prefix}/files/${id}/download-url`, {});

        for (const as of [actors.owner, actors.admin]) {
          for (const file of files) {
            const response = yield* mint(as, file.id);
            expect(response.status, `an owner or admin links ${file.id}`).toBe(200);
            const link = yield* body(Link, response);
            const served = yield* raw("GET", link.url);
            expect(served.status).toBe(200);
            expect(text(served.bytes)).toBe(file.text);
          }
        }
        // The owner's credential downloads any file of the organization.
        for (const file of files) {
          const served = yield* raw("GET", `${prefix}/files/${file.id}`, {
            headers: { authorization: `Bearer ${ownerKey}` },
          });
          expect(served.status).toBe(200);
          expect(text(served.bytes)).toBe(file.text);
        }

        // A member reaches only the files of apps they can use, by link and by download. A file
        // they cannot reach answers exactly as a file that does not exist.
        const unknown = "00000000-0000-4000-8000-000000000000";
        const absent = yield* mint(actors.member, unknown);
        expect(absent.status).toBe(404);
        expect(yield* tagOf(absent)).toBe("FileNotFound");
        for (const file of files) {
          const response = yield* mint(actors.member, file.id);
          if (file.visibleToMember) {
            expect(response.status).toBe(200);
            const served = yield* raw("GET", (yield* body(Link, response)).url);
            expect(text(served.bytes)).toBe(file.text);
          } else {
            expect(response.status, `a member links ${file.id}`).toBe(absent.status);
            expect(response.body).toEqual(absent.body);
          }
          const served = yield* raw("GET", `${prefix}/files/${file.id}`, {
            headers: { authorization: `Bearer ${memberKey}` },
          });
          if (file.visibleToMember) {
            expect(served.status).toBe(200);
            expect(text(served.bytes)).toBe(file.text);
          } else {
            expect(served.status, `a member downloads ${file.id}`).toBe(404);
            expect(text(served.bytes)).toContain("BlobNotFound");
          }
        }
        const unknownDownload = yield* raw("GET", `${prefix}/files/${unknown}`, {
          headers: { authorization: `Bearer ${memberKey}` },
        });
        expect(unknownDownload.status).toBe(404);

        // The dashboard mints with its cookie session and names the organization by slug before
        // it has verified the ID. The link then downloads the exact bytes with no credential. A
        // request that leaves the organization out reaches the route as "undefined" and is refused.
        const bySlug = yield* api.request(
          actors.owner,
          "POST",
          `/api/organizations/${actors.organization.slug}/files/${a.id}/download-url`,
          {},
        );
        expect(bySlug.status).toBe(200);
        const slugLink = yield* body(Link, bySlug);
        const slugServed = yield* raw("GET", slugLink.url);
        expect(slugServed.status).toBe(200);
        expect(text(slugServed.bytes)).toBe(content.a);
        const withoutOrganization = yield* api.request(
          actors.owner,
          "POST",
          `/api/organizations/undefined/files/${a.id}/download-url`,
          {},
        );
        expect(withoutOrganization.status).toBe(403);

        // A link minted before stays valid until it expires, whoever fetches it: a link is a
        // bearer secret the minting caller was entitled to.
        const early = yield* body(Link, yield* mint(actors.owner, b.id));
        expect(text((yield* raw("GET", early.url)).bytes)).toBe(content.b);

        // The Files page previews a PDF and a Markdown file from a minted link, so a link must
        // return exactly the stored bytes, kept an inert download whatever the type says.
        const pdfBytes = new Uint8Array([
          ...new TextEncoder().encode("%PDF-1.4\n"),
          0xff,
          0xfe,
          0x00,
          0x80,
          ...new TextEncoder().encode(`\n%%EOF ${unique}\n`),
        ]);
        const markdownBytes = new TextEncoder().encode(
          `# Preview ${unique}\n\n<script>alert(1)</script>\n\n![remote](https://example.invalid/x.png)\n`,
        );
        // Files an app stored are attributed to it, so the visibility rule applies to them; the
        // files uploaded with a key have no creator app. Text bytes are what a tool can store.
        // Each file has its own bytes, so none is the same stored object as another.
        const markdownFor = (owner: string) =>
          new TextEncoder().encode(`${text(markdownBytes)}\nowner: ${owner}\n`);
        const asciiPdf = new TextEncoder().encode(`%PDF-1.4\n%%EOF ${unique}\n`);
        const previewed = [
          { bytes: pdfBytes, contentType: "application/pdf", via: "upload", member: false },
          { bytes: markdownBytes, contentType: "text/markdown", via: "upload", member: false },
          { bytes: asciiPdf, contentType: "application/pdf", via: "appA", member: true },
          { bytes: markdownFor("appA"), contentType: "text/markdown", via: "appA", member: true },
          { bytes: markdownFor("appB"), contentType: "text/markdown", via: "appB", member: false },
        ] as const;
        const ids: string[] = [];
        for (const file of previewed) {
          if (file.via === "upload") {
            const put = yield* raw("PUT", `${prefix}/files`, {
              headers: {
                authorization: `Bearer ${ownerKey}`,
                "x-executor-content-type": file.contentType,
              },
              body: file.bytes,
            });
            expect(put.status).toBe(201);
            ids.push(
              (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Stored))(text(put.bytes)))
                .id,
            );
          } else {
            const app = file.via === "appA" ? appA : appB;
            const captured = yield* app.capture("captureText", {
              text: text(file.bytes),
              contentType: file.contentType,
            });
            ids.push(captured.handle.id);
          }
        }
        const listed = new Map(
          (yield* body(
            Page,
            yield* api.request(actors.owner, "GET", `${prefix}/files?limit=100`),
          )).files.map((entry) => [entry.id, entry]),
        );
        for (const [index, file] of previewed.entries()) {
          const id = ids[index]!;
          // The listing carries the type and size the drawer decides on before it fetches.
          expect(listed.get(id)).toMatchObject({
            contentType: file.contentType,
            size: file.bytes.length,
          });
          const link = yield* body(Link, yield* mint(actors.owner, id));
          const served = yield* fetchWithHeaders(link.url);
          expect(served.status).toBe(200);
          expect(Buffer.from(served.bytes).equals(Buffer.from(file.bytes))).toBe(true);
          expect(served.headers["content-disposition"]).toMatch(/^attachment/u);
          expect(served.headers["x-content-type-options"]).toBe("nosniff");
          expect(served.headers["content-security-policy"]).toContain("sandbox");
          // A member links the files of an app they can use, and gets the not-found answer for
          // the private app's file and for files no app created.
          const asMember = yield* mint(actors.member, id);
          if (file.member) {
            expect(asMember.status, `a member links ${file.via} ${id}`).toBe(200);
            const memberServed = yield* fetchWithHeaders((yield* body(Link, asMember)).url);
            expect(Buffer.from(memberServed.bytes).equals(Buffer.from(file.bytes))).toBe(true);
          } else {
            expect(asMember.status, `a member links ${file.via} ${id}`).toBe(absent.status);
            expect(asMember.body).toEqual(absent.body);
          }
        }

        // The Files page plays video and audio straight from a minted link, so the link must
        // answer a range with 206 and the stored media type, and the whole file with 200. The
        // dashboard asks for four hours; the host honors it and clamps nothing below the maximum.
        const box = (type: string, payload: Uint8Array) => {
          const out = new Uint8Array(8 + payload.length);
          new DataView(out.buffer).setUint32(0, out.length);
          out.set(new TextEncoder().encode(type), 4);
          out.set(payload, 8);
          return out;
        };
        const filler = (length: number, seed: number) =>
          Uint8Array.from({ length }, (_, index) => (index * 7 + seed) % 256);
        const mp4Bytes = new Uint8Array([
          ...box("ftyp", new TextEncoder().encode("isom\u0000\u0000\u0002\u0000isomiso2mp41")),
          ...box("mdat", filler(600, unique.charCodeAt(0))),
        ]);
        const wavBytes = new Uint8Array([
          ...new TextEncoder().encode("RIFF"),
          ...new Uint8Array(new Uint32Array([36 + 600]).buffer),
          ...new TextEncoder().encode("WAVEfmt "),
          ...new Uint8Array(new Uint32Array([16]).buffer),
          ...new Uint8Array(new Uint16Array([1, 1]).buffer),
          ...new Uint8Array(new Uint32Array([8000, 8000]).buffer),
          ...new Uint8Array(new Uint16Array([1, 8]).buffer),
          ...new TextEncoder().encode("data"),
          ...new Uint8Array(new Uint32Array([600]).buffer),
          ...filler(600, unique.charCodeAt(1)),
        ]);
        const media = [
          { bytes: mp4Bytes, contentType: "video/mp4" },
          { bytes: wavBytes, contentType: "audio/wav" },
        ] as const;
        for (const file of media) {
          const put = yield* raw("PUT", `${prefix}/files`, {
            headers: {
              authorization: `Bearer ${ownerKey}`,
              "x-executor-content-type": file.contentType,
            },
            body: file.bytes,
          });
          expect(put.status).toBe(201);
          const id = (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Stored))(
            text(put.bytes),
          )).id;
          const longLived = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/files/${id}/download-url`,
            { expiresInSeconds: 4 * 60 * 60 },
          );
          expect(longLived.status).toBe(200);
          const link = yield* body(Link, longLived);
          const hours = (Date.parse(link.expiresAt) - Date.now()) / 3_600_000;
          expect(hours).toBeGreaterThan(3.9);
          expect(hours).toBeLessThanOrEqual(4);

          const ranged = yield* fetchWithHeaders(link.url, { range: "bytes=0-99" });
          expect(ranged.status).toBe(206);
          expect(ranged.headers["content-range"]).toBe(`bytes 0-99/${file.bytes.length}`);
          expect(ranged.headers["content-type"]).toBe(file.contentType);
          expect(ranged.headers["accept-ranges"]).toBe("bytes");
          expect(Buffer.from(ranged.bytes).equals(Buffer.from(file.bytes.slice(0, 100)))).toBe(
            true,
          );
          const tail = yield* fetchWithHeaders(link.url, { range: "bytes=500-" });
          expect(tail.status).toBe(206);
          expect(Buffer.from(tail.bytes).equals(Buffer.from(file.bytes.slice(500)))).toBe(true);

          const whole = yield* fetchWithHeaders(link.url);
          expect(whole.status).toBe(200);
          expect(whole.headers["content-type"]).toBe(file.contentType);
          expect(Buffer.from(whole.bytes).equals(Buffer.from(file.bytes))).toBe(true);
          // The dashboard mints by organization slug with its cookie session.
          const bySlugMedia = yield* api.request(
            actors.owner,
            "POST",
            `/api/organizations/${actors.organization.slug}/files/${id}/download-url`,
            { expiresInSeconds: 4 * 60 * 60 },
          );
          expect(bySlugMedia.status).toBe(200);
        }
      }),
    ),
  );
});
