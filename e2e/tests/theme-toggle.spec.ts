/** The account menu switches the dashboard between light, dark and system themes. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains("dark"));
const stored = (page: Page) => page.evaluate(() => localStorage.getItem("executor:theme"));
const background = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

const openMenu = (page: Page) =>
  page
    .getByRole("button", { name: /^Account:/ })
    .click()
    .then(() => page.getByRole("menuitemradio", { name: "System" }).waitFor());
const choose = (page: Page, name: "Light" | "Dark" | "System") =>
  page.getByRole("menuitemradio", { name }).click();

layer(HostedLive, { excludeTestServices: true })("Theme toggle", (it) => {
  it.effect(scenarios.themeToggle.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser,
          actors = yield* Actors;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the dashboard in a light system", (page) =>
          page
            .emulateMedia({ colorScheme: "light" })
            .then(() => page.goto(`/org/${actors.organization.slug}/apps`))
            .then(() => page.getByRole("heading", { level: 1, name: /^Apps/ }).waitFor())
            .then(() => page.locator("html[data-hydrated]").waitFor({ state: "attached" })),
        );
        expect(yield* browser.use("Read the light document", isDark)).toBe(false);
        const light = yield* browser.use("Read the light background", background);

        yield* browser.use("Open the account menu", openMenu);
        expect(
          yield* browser.use("System is checked by default", (page) =>
            page.getByRole("menuitemradio", { name: "System" }).getAttribute("aria-checked"),
          ),
        ).toBe("true");
        yield* browser.checkpoint("Account menu in light mode");

        yield* browser.use("Choose Dark", (page) => choose(page, "Dark"));
        expect(yield* browser.use("Dark is applied", isDark)).toBe(true);
        expect(yield* browser.use("Dark is stored", stored)).toBe("dark");
        expect(yield* browser.use("Read the dark background", background)).not.toBe(light);
        expect(
          yield* browser.use("Dark is checked", (page) =>
            page.getByRole("menuitemradio", { name: "Dark" }).getAttribute("aria-checked"),
          ),
        ).toBe("true");
        yield* browser.checkpoint("Account menu in dark mode");

        // The pre-paint script sets the class before the document finishes parsing.
        yield* browser.use("Reload while dark is chosen", (page) =>
          page.reload({ waitUntil: "domcontentloaded" }),
        );
        expect(yield* browser.use("Dark persists after reload", isDark)).toBe(true);
        yield* browser.use("Wait for the dashboard", (page) =>
          page.getByRole("heading", { level: 1, name: /^Apps/ }).waitFor(),
        );
        expect(yield* browser.use("Dark still holds after hydration", isDark)).toBe(true);

        yield* browser.use("Choose Light with a dark system", (page) =>
          page
            .emulateMedia({ colorScheme: "dark" })
            .then(() => openMenu(page))
            .then(() => choose(page, "Light")),
        );
        expect(yield* browser.use("Light wins over the system", isDark)).toBe(false);
        expect(yield* browser.use("Light is stored", stored)).toBe("light");
        yield* browser.use("Reload while light is chosen", (page) =>
          page.reload({ waitUntil: "domcontentloaded" }),
        );
        expect(yield* browser.use("Light persists after reload", isDark)).toBe(false);

        yield* browser.use("Choose System with a dark system", (page) =>
          page
            .getByRole("heading", { level: 1, name: /^Apps/ })
            .waitFor()
            .then(() => openMenu(page))
            .then(() => choose(page, "System")),
        );
        expect(yield* browser.use("System follows a dark system", isDark)).toBe(true);
        expect(yield* browser.use("System clears the stored choice", stored)).toBeNull();
        // The browser delivers the media change event after emulation resolves.
        yield* browser.use("Switch the system to light", (page) =>
          page
            .emulateMedia({ colorScheme: "light" })
            .then(() =>
              page.waitForFunction(() => !document.documentElement.classList.contains("dark")),
            ),
        );
        expect(yield* browser.use("System follows the change live", isDark)).toBe(false);

        yield* browser.use("Choose Dark again", (page) => choose(page, "Dark"));
        yield* browser.use("Open the sign-in page", (page) =>
          page
            .context()
            .clearCookies()
            .then(() => page.goto("/login")),
        );
        expect(yield* browser.use("Sign-in page is dark", isDark)).toBe(true);
        yield* browser.checkpoint("Sign-in page in dark mode");
        yield* browser.use("Choose a light stored theme for sign-in", (page) =>
          page
            .evaluate(() => localStorage.setItem("executor:theme", "light"))
            .then(() => page.reload()),
        );
        expect(yield* browser.use("Sign-in page is light", isDark)).toBe(false);
        yield* browser.checkpoint("Sign-in page in light mode");
      }),
    ),
  );
});
