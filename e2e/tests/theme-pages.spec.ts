/** Every dashboard page is captured in both themes, and its text is measured against the colours behind it. */
import { expect, layer } from "@effect/vitest";
import type { Page } from "playwright";
import { Duration, Effect, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
import { McpClient } from "../support/mcp-client.ts";
import { appsManifest } from "../support/apps-release.ts";

/** Text whose colour barely differs from what it sits on, found by compositing real backgrounds. */
const lowContrastText = (page: Page, minimum: number) =>
  page.evaluate((minimum) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const paint = canvas.getContext("2d", { willReadFrequently: true });
    if (!paint) throw new Error("No canvas context");
    const rgba = (css: string): [number, number, number, number] => {
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = "#000";
      paint.fillStyle = css;
      paint.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = paint.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top: number[], below: number[]): [number, number, number] => {
      const alpha = top[3] ?? 1;
      return [0, 1, 2].map((i) => (top[i] ?? 0) * alpha + (below[i] ?? 0) * (1 - alpha)) as [
        number,
        number,
        number,
      ];
    };
    const luminance = (rgb: number[]) => {
      const [r = 0, g = 0, b = 0] = rgb.map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const backdrop = (element: Element): [number, number, number] => {
      const chain: Element[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) chain.push(node);
      let color: [number, number, number] = over(
        rgba(getComputedStyle(document.body).backgroundColor),
        [255, 255, 255],
      );
      for (const node of chain.reverse()) {
        const background = rgba(getComputedStyle(node).backgroundColor);
        if (background[3] > 0) color = over(background, color);
      }
      return color;
    };
    const found: Array<{ text: string; ratio: number; color: string; background: string }> = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const element = node.parentElement;
      if (!text || !element || !/[\p{L}\p{N}]/u.test(text)) continue;
      if (
        element.closest("[disabled], [aria-disabled='true'], [aria-hidden='true'], script, style")
      )
        continue;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      if (box.width < 2 || box.height < 2 || style.visibility === "hidden") continue;
      let opacity = 1;
      for (let up: Element | null = element; up; up = up.parentElement)
        opacity *= Number(getComputedStyle(up).opacity);
      if (opacity < 0.1) continue;
      const background = backdrop(element);
      const foreground = rgba(style.color);
      const shown = over(
        [foreground[0], foreground[1], foreground[2], foreground[3] * opacity],
        background,
      );
      const [lighter = 0, darker = 0] = [luminance(shown), luminance(background)].sort(
        (a, b) => b - a,
      );
      const ratio = (lighter + 0.05) / (darker + 0.05);
      if (ratio < minimum)
        found.push({
          text: text.slice(0, 40),
          ratio: Math.round(ratio * 100) / 100,
          color: style.color,
          background: `rgb(${background.map(Math.round).join(",")})`,
        });
    }
    for (const input of document.querySelectorAll("input[placeholder], textarea[placeholder]")) {
      const box = input.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) continue;
      const background = backdrop(input);
      const color = rgba(getComputedStyle(input, "::placeholder").color);
      const shown = over(color, background);
      const [lighter = 0, darker = 0] = [luminance(shown), luminance(background)].sort(
        (a, b) => b - a,
      );
      const ratio = (lighter + 0.05) / (darker + 0.05);
      if (ratio < minimum)
        found.push({
          text: `placeholder ${input.getAttribute("placeholder")}`,
          ratio: Math.round(ratio * 100) / 100,
          color: getComputedStyle(input, "::placeholder").color,
          background: `rgb(${background.map(Math.round).join(",")})`,
        });
    }
    return found;
  }, minimum);

const themeCase = (theme: "dark" | "light") =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      browser = yield* Browser,
      mcp = yield* McpClient;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const app = yield* body(
      App,
      yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: `Theme app ${randomUUID().slice(0, 8)}`,
        files: [
          {
            path: "index.ts",
            content: `import { defineApp, query, object, router } from "apps";
export default defineApp({}, { tools: router({
  status: query({ input: object({}), description: "Query status" }, async () => "ready"),
  explode: query({ input: object({}), description: "Always fails" }, async () => { throw new Error("exploded"); }),
}) });`,
          },
          appsManifest,
        ],
      }),
    );
    yield* Effect.addFinalizer(() =>
      api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(
        Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
        Effect.orDie,
      ),
    );
    // Tool calls give the Home page's usage chart and tables something to draw.
    const key = yield* body(
      Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) }),
      yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
        name: "Theme agent",
      }),
    );
    yield* Effect.addFinalizer(() =>
      api
        .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: key.id })
        .pipe(Effect.orDie),
    );
    const client = yield* mcp.connect(key.key as Redacted.Redacted<string>, "theme-agent", {
      organization: actors.organization.id,
      clientName: "Theme agent",
    });
    for (const tool of ["status", "status", "explode"])
      yield* client.use(`Call ${tool}`, (client, signal) =>
        client.callTool(
          {
            name: "call",
            arguments: {
              calls: { path: `tools[${JSON.stringify(app.slug)}].${tool}`, input: {} },
            },
          },
          undefined,
          { signal },
        ),
      );
    yield* Effect.gen(function* () {
      const report = yield* body(
        Schema.Struct({ totals: Schema.Struct({ calls: Schema.Number }) }),
        yield* api.request(actors.owner, "GET", `${prefix}/usage?range=7d`),
      );
      if (report.totals.calls !== 3) return yield* Effect.fail("Usage not recorded yet");
    }).pipe(
      Effect.retry({ schedule: Schedule.spaced(Duration.millis(500)), times: 20 }),
      Effect.orDie,
    );
    yield* browser.login(actors.owner);
    yield* browser.use("Set the desktop viewport", (page) =>
      page.setViewportSize({ width: 1280, height: 800 }),
    );
    const org = `/org/${actors.organization.slug}`;
    const pages: ReadonlyArray<readonly [string, string]> = [
      ["Home", org],
      ["Apps", `${org}/apps`],
      ["App detail", `${org}/apps/${app.id}`],
      ["App tools", `${org}/apps/${app.id}?view=tools`],
      ["App accounts", `${org}/apps/${app.id}?view=accounts`],
      ["App source", `${org}/apps/${app.id}?view=source`],
      ["App settings", `${org}/apps/${app.id}?view=settings`],
      ["Connections", `${org}/connect`],
      ["Accounts", `${org}/accounts`],
      ["Approvals", `${org}/approvals`],
      ["Groups", `${org}/groups`],
      ["Organization settings", `${org}/organization`],
      ["Account profile", `/account/profile?organization=${actors.organization.slug}`],
      ["Account security", `/account/security?organization=${actors.organization.slug}`],
      ["Account tokens", `/account/tokens?organization=${actors.organization.slug}`],
      ["Add app", `${org}/apps/add`],
      ["Custom app", `${org}/apps/add/custom`],
    ];
    // Overlays and expanded rows draw their own surfaces, so each is captured open.
    const overlay = (
      Theme: string,
      label: string,
      path: string,
      open: (page: Page) => Promise<unknown>,
    ) =>
      Effect.gen(function* () {
        yield* browser.use(`Open ${label} page`, (page) => page.goto(path));
        yield* browser.use(`${label} page finished loading`, (page) =>
          page.waitForLoadState("networkidle"),
        );
        yield* browser.use(`Open ${label}`, open);
        yield* browser.use(`${label} finished animating`, (page) =>
          page.evaluate(() =>
            Promise.all(document.getAnimations().map((animation) => animation.finished)),
          ),
        );
        const faint = yield* browser.use(`${label} text contrast`, (page) =>
          lowContrastText(page, 4.5),
        );
        expect(faint, `${label} text below 4.5:1`).toEqual([]);
        yield* browser.checkpoint(`${Theme} ${label}`);
      });
    const Theme = theme === "dark" ? "Dark" : "Light";
    yield* browser.use(`Choose the ${theme} theme`, (page) =>
      page.addInitScript((theme) => localStorage.setItem("executor:theme", theme), theme),
    );
    for (const [label, path] of pages) {
      yield* browser.use(`Open ${label}`, (page) => page.goto(path));
      yield* browser.use(`${label} finished loading`, (page) =>
        page.waitForLoadState("networkidle"),
      );
      expect(
        yield* browser.use(`${label} follows the ${theme} theme`, (page) =>
          page.evaluate(() => document.documentElement.classList.contains("dark")),
        ),
      ).toBe(theme === "dark");
      const faint = yield* browser.use(`${label} text contrast`, (page) =>
        lowContrastText(page, 4.5),
      );
      expect(faint, `${label} text below 4.5:1`).toEqual([]);
      yield* browser.checkpoint(`${Theme} ${label}`);
    }

    yield* overlay(Theme, "Home agent row", org, (page) =>
      page.getByRole("button", { name: /Theme agent/ }).click(),
    );
    yield* overlay(Theme, "Create group dialog", `${org}/groups`, (page) =>
      page.getByRole("button", { name: "Create group" }).first().click(),
    );
    yield* overlay(Theme, "Create token dialog", "/account/tokens", (page) =>
      page.getByRole("button", { name: "Create token" }).click(),
    );
    yield* overlay(Theme, "Add member dialog", `${org}/organization`, (page) =>
      page.getByRole("button", { name: "Add member" }).click(),
    );
    yield* overlay(Theme, "Account menu", `${org}/apps`, (page) =>
      page.getByRole("button", { name: /Test Owner/ }).click(),
    );
    yield* overlay(Theme, "Organization menu", `${org}/apps`, (page) =>
      page.getByRole("button", { name: /^Organization:/ }).click(),
    );
    yield* overlay(Theme, "Command bar", `${org}/apps`, (page) => page.keyboard.press("Control+K"));
  }).pipe(Effect.provide(McpClient.layer));

layer(HostedLive, { excludeTestServices: true })("Themes", (it) => {
  it.effect(scenarios.darkPages.title, (context) => withHostedCase(context, themeCase("dark")));
  it.effect(scenarios.lightPages.title, (context) => withHostedCase(context, themeCase("light")));
});
