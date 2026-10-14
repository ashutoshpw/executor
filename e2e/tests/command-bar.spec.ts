import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Organization } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

layer(HostedLive, { excludeTestServices: true })("Command bar", (it) => {
  it.effect(scenarios.commandBar.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const name = `Palette app ${randomUUID().slice(0, 8)}`;
        const app = yield* body(
          App,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, query, object, router } from "apps";
export default defineApp({}, { tools: router({ status: query({ input: object({}) }, async () => "ready") }) });`,
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
        const neighbourName = `Palette neighbour ${randomUUID().slice(0, 8)}`;
        const neighbourResponse = yield* api.request(
          actors.owner,
          "POST",
          "/api/auth/organization/create",
          {
            name: neighbourName,
            slug: `palette-${randomUUID().slice(0, 8)}`,
            keepCurrentActiveOrganization: true,
          },
        );
        expect(neighbourResponse.status).toBe(200);
        const neighbour = yield* body(Organization, neighbourResponse);
        // Self-host has no organization removal; its server is isolated to this scenario.
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `/api/organizations/${neighbour.id}`).pipe(
            Effect.tap((response) =>
              Effect.sync(() => expect([200, 404]).toContain(response.status)),
            ),
            Effect.orDie,
          ),
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Set the desktop viewport", (page) =>
          page.setViewportSize({ width: 1280, height: 800 }),
        );
        yield* browser.use("Open Apps", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("Wait for the app", (page) =>
          page.getByRole("link", { name: `Open ${name}`, exact: true }).waitFor(),
        );
        yield* browser.use("Mark the document to detect a reload", (page) =>
          page.evaluate(() => {
            Reflect.set(window, "commandBarMarker", true);
          }),
        );

        const dialog = (page: Page) => page.getByRole("dialog", { name: "Command bar" });
        const focused = (label: string, name: string | RegExp, role: "combobox" | "button") =>
          browser.use(label, (page) =>
            page
              .getByRole(role, { name })
              .evaluate((element) => element === document.activeElement),
          );

        yield* browser.use("Open with Ctrl+K", (page) => page.keyboard.press("Control+K"));
        yield* browser.use("The palette is a labelled dialog", (page) => dialog(page).waitFor());
        expect(yield* focused("The combobox has focus", /./, "combobox")).toBe(true);
        yield* browser.use("The opening animation finished", (page) =>
          dialog(page).evaluate((element) =>
            Promise.all(element.getAnimations().map((animation) => animation.finished)),
          ),
        );
        yield* browser.checkpoint("Command bar open");
        for (const heading of ["Navigate", "Apps", "Account"])
          yield* browser.use(`The ${heading} group is listed`, (page) =>
            dialog(page).getByRole("group", { name: heading }).waitFor(),
          );
        expect(
          yield* browser.use("The first option is active", (page) =>
            page.getByRole("option").first().getAttribute("aria-selected"),
          ),
        ).toBe("true");
        yield* browser.use("Arrow down moves the active option", (page) =>
          page.keyboard.press("ArrowDown"),
        );
        expect(
          yield* browser.use("The second option is active", (page) =>
            page.getByRole("option").nth(1).getAttribute("aria-selected"),
          ),
        ).toBe("true");
        expect(
          yield* browser.use("The first option is no longer active", (page) =>
            page.getByRole("option").first().getAttribute("aria-selected"),
          ),
        ).toBe("false");
        yield* browser.use("Meta+K toggles it closed", (page) => page.keyboard.press("Meta+K"));
        yield* browser.use("The palette closed", (page) =>
          dialog(page).waitFor({ state: "hidden" }),
        );
        yield* browser.use("Meta+K opens it again", (page) => page.keyboard.press("Meta+K"));
        yield* browser.use("The palette reopened", (page) => dialog(page).waitFor());
        yield* browser.use("Filter to Connections", (page) =>
          page.getByRole("combobox").fill("connections"),
        );
        yield* browser.use("The match is listed", (page) =>
          page.getByRole("option", { name: /Connections/ }).waitFor(),
        );
        expect(
          yield* browser.use("The match is the active option", (page) =>
            page.getByRole("option", { name: /Connections/ }).getAttribute("aria-selected"),
          ),
        ).toBe("true");
        expect(
          yield* browser.use("Only the match is listed", (page) =>
            page.getByRole("option").count(),
          ),
        ).toBe(1);
        yield* browser.use("Enter navigates", (page) => page.keyboard.press("Enter"));
        yield* browser.use("The Connections page opens", (page) => page.waitForURL(/\/connect$/));
        yield* browser.use("The palette closed", (page) =>
          dialog(page).waitFor({ state: "hidden" }),
        );

        yield* browser.use("Open with the trigger", (page) =>
          page.getByRole("button", { name: "Search", exact: true }).click(),
        );
        yield* browser.use("Filter to the app", (page) => page.getByRole("combobox").fill(name));
        yield* browser.use("The app is listed", (page) =>
          page.getByRole("option", { name: new RegExp(name) }).waitFor(),
        );
        yield* browser.use("Enter opens the app page", (page) => page.keyboard.press("Enter"));
        yield* browser.use("The app page opens", (page) =>
          page.waitForURL(new RegExp(`/apps/${app.id}`)),
        );
        expect(
          yield* browser.use("No full page reload happened", (page) =>
            page.evaluate(() => Reflect.get(window, "commandBarMarker")),
          ),
        ).toBe(true);

        yield* browser.use("Open again with the trigger", (page) =>
          page.getByRole("button", { name: "Search", exact: true }).click(),
        );
        yield* browser.use("The palette is open", (page) => dialog(page).waitFor());
        yield* browser.use("Press Escape", (page) => page.keyboard.press("Escape"));
        yield* browser.use("The palette closed", (page) =>
          dialog(page).waitFor({ state: "hidden" }),
        );
        expect(yield* focused("Focus returns to the trigger", "Search", "button")).toBe(true);

        yield* browser.use("Open before switching organization", (page) =>
          page.getByRole("button", { name: "Search", exact: true }).click(),
        );
        yield* browser.use("The Organizations group is listed", (page) =>
          dialog(page).getByRole("group", { name: "Organizations" }).waitFor(),
        );
        yield* browser.use("Filter to the other organization", (page) =>
          page.getByRole("combobox").fill(neighbourName),
        );
        expect(
          yield* browser.use("Only the other organization is listed", (page) =>
            dialog(page)
              .getByRole("group", { name: "Organizations" })
              .getByRole("option")
              .allTextContents(),
          ),
        ).toEqual([`Switch to ${neighbourName}`]);
        yield* browser.use("Enter switches organization", (page) => page.keyboard.press("Enter"));
        yield* browser.use("The other organization opens on its Home page", (page) =>
          page.waitForURL(new RegExp(`/org/${neighbour.slug}(?:\\?[^/]*)?$`)),
        );
        yield* browser.use("The palette closed after switching", (page) =>
          dialog(page).waitFor({ state: "hidden" }),
        );
        yield* browser.use("The switcher shows the other organization", (page) =>
          page
            .getByRole("button", { name: `Organization: ${neighbourName}` })
            .first()
            .waitFor(),
        );
        expect(
          yield* browser.use("Switching organization did not reload the page", (page) =>
            page.evaluate(() => Reflect.get(window, "commandBarMarker")),
          ),
        ).toBe(true);

        yield* browser.use("Fail the next sign-out", (page) =>
          page.route("**/sign-out", (route) => route.fulfill({ status: 500, body: "{}" })),
        );
        yield* browser.use("Open before signing out", (page) =>
          page.getByRole("button", { name: "Search", exact: true }).click(),
        );
        yield* browser.use("Choose Sign out", (page) =>
          page.getByRole("combobox").fill("sign out"),
        );
        yield* browser.use("Enter signs out", (page) => page.keyboard.press("Enter"));
        yield* browser.use("The failure is shown in the palette", (page) =>
          dialog(page).getByRole("alert").waitFor(),
        );
        expect(
          yield* browser.use("The palette stays open and signed in", (page) =>
            dialog(page).isVisible(),
          ),
        ).toBe(true);
        yield* browser.use("Allow sign-out again", (page) => page.unroute("**/sign-out"));
        yield* browser.use("Close the palette", (page) => page.keyboard.press("Escape"));
        yield* browser.use("The palette closed", (page) =>
          dialog(page).waitFor({ state: "hidden" }),
        );

        yield* browser.use("Open the account area from an organization", (page) =>
          page.goto(`/account/profile?organization=${actors.organization.slug}`),
        );
        yield* browser.use("Open on an account page", (page) => page.keyboard.press("Control+K"));
        yield* browser.use("The palette is open on the account page", (page) =>
          dialog(page).waitFor(),
        );
        for (const label of ["Profile", "Security", "Tokens", "Back to organization", "Sign out"])
          yield* browser.use(`${label} is offered`, (page) =>
            page.getByRole("option", { name: new RegExp(label) }).waitFor(),
          );
        yield* browser.use("Choose Security", (page) =>
          page.getByRole("combobox").fill("security"),
        );
        yield* browser.use("Enter opens Security", (page) => page.keyboard.press("Enter"));
        yield* browser.use("The organization return context is kept", (page) =>
          page.waitForURL(
            (url) =>
              url.pathname === "/account/security" &&
              url.searchParams.get("organization") === actors.organization.slug,
          ),
        );

        yield* browser.use("Set the phone viewport", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* browser.use("Open the phone menu", (page) =>
          page.getByRole("button", { name: "Menu" }).click(),
        );
        yield* browser.use("Open from the phone menu", (page) =>
          page.getByRole("button", { name: "Search", exact: true }).click(),
        );
        yield* browser.use("The palette is open", (page) => dialog(page).waitFor());
        yield* browser.use("The Menu sheet closed", (page) =>
          page.getByRole("dialog", { name: "Menu" }).waitFor({ state: "hidden" }),
        );
        yield* browser.use("Filter to the account pages", (page) =>
          page.getByRole("combobox").fill("profile"),
        );
        yield* browser.use("Profile is listed", (page) =>
          page.getByRole("option", { name: /Profile/ }).waitFor(),
        );
        yield* browser.use("The opening animation finished", (page) =>
          dialog(page).evaluate((element) =>
            Promise.all(element.getAnimations().map((animation) => animation.finished)),
          ),
        );
        expect(
          yield* browser.use("The palette fits the phone viewport", (page) =>
            dialog(page).evaluate((element) => {
              const box = element.getBoundingClientRect();
              return (
                box.left >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight
              );
            }),
          ),
        ).toBe(true);
        yield* browser.use("Filter to sign out", (page) =>
          page.getByRole("combobox").fill("sign out"),
        );
        yield* browser.use("Sign out is listed", (page) =>
          page.getByRole("option", { name: /Sign out/ }).waitFor(),
        );
        yield* browser.checkpoint("Command bar open on a phone");
        yield* browser.use("Close the phone palette", (page) => page.keyboard.press("Escape"));
        yield* browser.use("The palette closed", (page) =>
          dialog(page).waitFor({ state: "hidden" }),
        );
        expect(
          yield* browser.use("Focus returns to the Menu button", (page) =>
            page
              .getByRole("button", { name: "Menu" })
              .evaluate((element) => element === document.activeElement),
          ),
        ).toBe(true);
      }),
    ),
  );
});
