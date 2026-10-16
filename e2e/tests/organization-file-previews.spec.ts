/**
 * The Files page previews images, text, HTML, CSV, TSV and Excel workbooks in its drawer. Each file is
 * uploaded over HTTP and opened through the real page, so the assertions see what a person sees.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { strToU8, zipSync } from "fflate";
import type { Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const Stored = Schema.Struct({ id: Schema.String });

const sheetXml = (rows: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;

/** A two-sheet workbook with a shared string, a number, a boolean and a date (number format 14). */
const workbook = () =>
  zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
    ),
    "xl/sharedStrings.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>Hello shared</t></si></sst>`,
    ),
    "xl/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      sheetXml(
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c><c r="C1" t="b"><v>1</v></c></row><row r="3"><c r="B3" s="1"><v>45000</v></c></row>`,
      ),
    ),
    "xl/worksheets/sheet2.xml": strToU8(
      sheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>Second sheet</t></is></c></row>`),
    ),
  });

const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const svg = strToU8(
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="teal"/></svg>`,
);
// 24,576 lines of 64 bytes: 1.5 MiB, of which the preview shows the first 16,384 lines.
const large = strToU8(
  Array.from(
    { length: 24_576 },
    (_, index) => `${String(index + 1).padStart(5, "0")} ${"x".repeat(57)}\n`,
  ).join(""),
);

const htmlHeading = "Sandboxed heading 7f3a9c";
const htmlDocument = `<!doctype html><html><head><title>Original title</title><link rel="stylesheet" href="https://example.invalid/style.css"></head><body><h1>${htmlHeading}</h1><img src="https://example.invalid/pixel.png" alt="remote"><script>document.title = "script ran"; document.body.insertAdjacentHTML("beforeend", '<p id="script-marker">ran</p>');</script></body></html>`;

layer(HostedLive, { excludeTestServices: true })("Organization file previews", (it) => {
  it.effect(scenarios.organizationFilePreviews.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const browser = yield* Browser;
        const target = yield* Target;
        const client = yield* HttpClient.HttpClient;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const created = yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
          name: "File previews",
          metadata: { organization: actors.organization.id },
        });
        expect(created.status).toBe(200);
        const key = yield* body(Key, created);
        const ids: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id });
            for (const id of ids)
              yield* api.request(actors.owner, "DELETE", `${prefix}/files/${id}`);
          }).pipe(Effect.orDie),
        );
        const upload = (contentType: string, bytes: Uint8Array) =>
          Effect.scoped(
            Effect.gen(function* () {
              const response = yield* client.execute(
                HttpClientRequest.bodyUint8Array(
                  HttpClientRequest.put(new URL(`${prefix}/files`, target.metadata.origin), {
                    headers: {
                      authorization: `Bearer ${Redacted.value(key.key)}`,
                      "x-executor-content-type": contentType,
                    },
                  }),
                  bytes,
                ),
              );
              expect(response.status).toBe(201);
              const stored = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Stored))(
                new TextDecoder().decode(yield* response.arrayBuffer),
              );
              ids.push(stored.id);
              return stored.id;
            }),
          ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));

        const pngId = yield* upload("image/png", png);
        const svgId = yield* upload("image/svg+xml", svg);
        const textId = yield* upload(
          "text/plain; charset=utf-8",
          strToU8("héllo wörld — 日本語\nsecond line\nthird line\n"),
        );
        const csvId = yield* upload(
          "text/csv; charset=utf-8",
          strToU8('name,note\r\n"Smith, Jane","line one\nline two"\r\nBob,plain\r\n'),
        );
        const tsvId = yield* upload(
          "text/tab-separated-values; charset=utf-8",
          strToU8("alpha\tbeta\n1\t2\n"),
        );
        const xlsxId = yield* upload(
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          workbook(),
        );
        const htmlId = yield* upload("text/html; charset=utf-8", strToU8(htmlDocument));
        const largeId = yield* upload("text/plain", large);
        const zipId = yield* upload("application/zip", zipSync({ "a.txt": strToU8("a") }));

        yield* browser.login(actors.owner);
        yield* browser.use("Open the Files page", (page) =>
          page.goto(`/org/${actors.organization.slug}/files`),
        );
        const drawerOf = (page: Page) => page.getByRole("dialog");
        const open = (id: string) =>
          Effect.gen(function* () {
            yield* browser.use(`Open the preview of ${id}`, (page) =>
              page.getByRole("button", { name: `Preview ${id}`, exact: true }).click(),
            );
            yield* browser.use("The drawer opens", (page) =>
              drawerOf(page).waitFor({ state: "visible" }),
            );
          });
        const close = Effect.gen(function* () {
          yield* browser.use("Close the preview", (page) => page.keyboard.press("Escape"));
          yield* browser.use("The drawer closes", (page) =>
            drawerOf(page).waitFor({ state: "hidden" }),
          );
        });

        // The drawer is bookmarkable: opening a file puts it in the address, a direct visit to
        // that address opens it, and closing removes it again.
        const fileParam = (page: Page) =>
          Promise.resolve(new URL(page.url()).searchParams.get("file"));
        yield* open(textId);
        expect(yield* browser.use("Read the address", (page) => fileParam(page))).toBe(textId);
        yield* browser.use("Reload the page", (page) => page.reload());
        yield* browser.use("The drawer opens again", (page) =>
          drawerOf(page).getByRole("region", { name: "File text" }).waitFor(),
        );
        yield* close;
        yield* browser.use("The address drops the file", (page) =>
          page.waitForURL((url) => url.searchParams.get("file") === null),
        );
        // Closing replaces the history entry the open added, so Back does not reopen the drawer.
        yield* browser.use("Go back after closing", (page) => page.goBack());
        yield* browser.use("The drawer stays closed", (page) =>
          drawerOf(page).waitFor({ state: "hidden" }),
        );
        expect(yield* browser.use("Read the address", (page) => fileParam(page))).toBeNull();
        yield* browser.use("Visit the address of a file", (page) =>
          page.goto(`/org/${actors.organization.slug}/files?file=${pngId}`),
        );
        yield* browser.use("The drawer opens for the linked file", (page) =>
          drawerOf(page).locator("[data-image-size]").waitFor(),
        );
        yield* close;
        yield* browser.use("Visit the address of a file that does not exist", (page) =>
          page.goto(
            `/org/${actors.organization.slug}/files?file=00000000-0000-4000-8000-000000000000`,
          ),
        );
        yield* browser.use("The notice appears", (page) =>
          page.getByRole("alert").filter({ hasText: "This file is no longer available" }).waitFor(),
        );
        yield* browser.use("Dismiss the notice", (page) =>
          page.getByRole("button", { name: "Dismiss" }).click(),
        );
        yield* browser.use("The notice goes", (page) =>
          page
            .getByRole("alert")
            .filter({ hasText: "This file is no longer available" })
            .waitFor({ state: "hidden" }),
        );
        expect(yield* browser.use("Read the address", (page) => fileParam(page))).toBeNull();

        // An image is shown from its link, and its natural size is read once it loads.
        for (const [id, size] of [
          [pngId, "1 × 1"],
          [svgId, "40 × 20"],
        ] as const) {
          yield* open(id);
          yield* browser.use("The image and its size appear", (page) =>
            drawerOf(page).locator(`[data-image-size]:text-is("${size}")`).waitFor(),
          );
          yield* browser.use("Switch to the actual size", (page) =>
            drawerOf(page).getByRole("radio", { name: "Actual size" }).click(),
          );
          const shown = yield* browser.use("Read the image", (page) =>
            drawerOf(page)
              .locator("img")
              .evaluate((element: HTMLImageElement) => ({
                width: element.naturalWidth,
                height: element.naturalHeight,
                complete: element.complete,
              })),
          );
          expect(shown.complete).toBe(true);
          expect(shown.width).toBeGreaterThan(0);
          expect(`${shown.width} × ${shown.height}`).toBe(size);
          yield* close;
        }

        // Text keeps its non-ASCII characters and numbers its lines.
        yield* open(textId);
        const region = (page: Page) => drawerOf(page).getByRole("region", { name: "File text" });
        yield* browser.use("The text appears", (page) => region(page).waitFor());
        const plain = yield* browser.use("Read the text", (page) =>
          Promise.all([
            region(page).textContent(),
            drawerOf(page).locator("[data-line-number]").allTextContents(),
            drawerOf(page).locator("[data-line-count]").textContent(),
          ]),
        );
        expect(plain[0]).toContain("héllo wörld — 日本語");
        expect(plain[0]).toContain("third line");
        expect(plain[1]).toEqual(["1", "2", "3"]);
        expect(plain[2]).toBe("3 lines");
        yield* close;

        // HTML renders in a sandboxed frame: its script does not run and nothing it names is fetched.
        const remoteRequests: string[] = [];
        // A route answers the remote hosts, so a request that leaves the page is recorded; one the
        // frame's policy blocks never reaches it.
        yield* browser.use("Answer the document's remote hosts", (page) =>
          page.route(/^https?:\/\/example\.invalid\//u, (route) => {
            remoteRequests.push(route.request().url());
            return route.fulfill({ status: 200, contentType: "text/css", body: "h1{color:red}" });
          }),
        );
        yield* open(htmlId);
        const preview = (page: Page) => drawerOf(page).locator("iframe");
        yield* browser.use("The preview is selected", (page) =>
          drawerOf(page).getByRole("radio", { name: "Preview" }).waitFor(),
        );
        expect(
          yield* browser.use("Read the selection", (page) =>
            drawerOf(page).getByRole("radio", { name: "Preview" }).getAttribute("aria-checked"),
          ),
        ).toBe("true");
        yield* browser.use("The heading renders in the frame", (page) =>
          preview(page).contentFrame().getByRole("heading", { name: htmlHeading }).waitFor(),
        );
        const frame = yield* browser.use("Read the frame", (page) =>
          Promise.all([
            preview(page).getAttribute("sandbox"),
            preview(page).getAttribute("referrerpolicy"),
            preview(page).contentFrame().locator("#script-marker").count(),
            preview(page)
              .contentFrame()
              .locator("html")
              .evaluate((element) => element.ownerDocument.title),
          ]),
        );
        expect(frame[0]).toBe("");
        expect(frame[1]).toBe("no-referrer");
        expect(frame[2]).toBe(0);
        expect(frame[3]).not.toBe("script ran");
        yield* browser.use("Switch to the HTML source", (page) =>
          drawerOf(page).getByRole("radio", { name: "Raw" }).click(),
        );
        const htmlSource = yield* browser.use("Read the HTML source", (page) =>
          drawerOf(page).locator("pre").textContent(),
        );
        expect(htmlSource).toContain("<script>");
        expect(htmlSource).toContain(htmlHeading);
        yield* browser.use("Wait for any late requests", (page) => page.waitForTimeout(500));
        expect(remoteRequests).toEqual([]);
        yield* close;

        // A file past the text limit is cut, with a note, instead of refused.
        yield* open(largeId);
        yield* browser.use("The note appears", (page) =>
          drawerOf(page).locator("[data-truncated]").waitFor(),
        );
        const cut = yield* browser.use("Read the cut text", (page) =>
          Promise.all([
            drawerOf(page).locator("[data-truncated]").textContent(),
            drawerOf(page).locator("[data-line-count]").textContent(),
          ]),
        );
        expect(cut[0]).toBe(
          "Showing the first 1 MiB of 1.5 MiB. Download the file to see all of it.",
        );
        expect(cut[1]).toBe("16,384 lines");
        yield* close;

        // CSV: quoted commas and line breaks stay in one cell; the first row is the header.
        yield* open(csvId);
        const grid = (page: Page, name: string) => drawerOf(page).getByRole("region", { name });
        yield* browser.use("The table appears", (page) => grid(page, "Table").waitFor());
        const csv = yield* browser.use("Read the CSV table", (page) =>
          Promise.all([
            grid(page, "Table").getByRole("columnheader").allTextContents(),
            grid(page, "Table").getByRole("cell").allTextContents(),
            drawerOf(page)
              .getByText(/^Showing \d+ of \d+ rows/u)
              .textContent(),
          ]),
        );
        expect(csv[0]).toEqual(["Row", "name", "note"]);
        expect(csv[1]).toEqual(["Smith, Jane", "line one\nline two", "Bob", "plain"]);
        expect(csv[2]).toBe("Showing 2 of 2 rows");
        yield* browser.use("Switch to the raw text", (page) =>
          drawerOf(page).getByRole("radio", { name: "Raw" }).click(),
        );
        expect(
          yield* browser.use("Read the raw CSV", (page) => region(page).textContent()),
        ).toContain('"Smith, Jane"');
        yield* close;

        yield* open(tsvId);
        yield* browser.use("The table appears", (page) => grid(page, "Table").waitFor());
        const tsv = yield* browser.use("Read the TSV table", (page) =>
          Promise.all([
            grid(page, "Table").getByRole("columnheader").allTextContents(),
            grid(page, "Table").getByRole("cell").allTextContents(),
          ]),
        );
        expect(tsv[0]).toEqual(["Row", "alpha", "beta"]);
        expect(tsv[1]).toEqual(["1", "2"]);
        yield* close;

        // A workbook: sheet tabs switch the cells, sparse rows keep their numbers, dates are ISO.
        yield* open(xlsxId);
        yield* browser.use("The sheet appears", (page) => grid(page, "Sheet").waitFor());
        const readSheet = (label: string) =>
          browser.use(label, (page) =>
            Promise.all([
              grid(page, "Sheet").getByRole("columnheader").allTextContents(),
              grid(page, "Sheet").locator("[data-row-number]").allTextContents(),
              grid(page, "Sheet").getByRole("cell").allTextContents(),
            ]),
          );
        expect(
          yield* browser.use("Read the tabs", (page) =>
            drawerOf(page).getByRole("tab").allTextContents(),
          ),
        ).toEqual(["Sales", "Notes"]);
        const sales = yield* readSheet("Read the first sheet");
        expect(sales[0]).toEqual(["Row", "A", "B", "C"]);
        expect(sales[1]).toEqual(["1", "3"]);
        expect(sales[2]).toEqual(["Hello shared", "42", "TRUE", "", "2023-03-15", ""]);
        yield* browser.use("Switch to the second sheet", (page) =>
          drawerOf(page).getByRole("tab", { name: "Notes" }).click(),
        );
        yield* browser.use("The second sheet appears", (page) =>
          grid(page, "Sheet").getByRole("cell", { name: "Second sheet" }).waitFor(),
        );
        const notes = yield* readSheet("Read the second sheet");
        expect(notes[0]).toEqual(["Row", "A"]);
        expect(notes[2]).toEqual(["Second sheet"]);
        yield* close;

        // Anything else is still downloaded, not previewed.
        yield* open(zipId);
        expect(
          yield* browser.use("Read the notice", (page) =>
            drawerOf(page).getByText("This file type cannot be previewed").textContent(),
          ),
        ).toContain("cannot be previewed");
      }),
    ),
  );
});
