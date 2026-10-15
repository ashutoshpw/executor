import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Organization settings tabs", (it) => {
  it.effect(scenarios.organizationSettingsTabs.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        const settings = `/org/${actors.organization.slug}/organization`;
        const selected = (name: string) =>
          browser.use(`The ${name} tab is selected`, (page) =>
            page.getByRole("tab", { name, exact: true }).getAttribute("aria-selected"),
          );
        const query = browser.use("Read the tab in the address", (page) =>
          Promise.resolve(new URL(page.url()).searchParams.get("tab")),
        );

        yield* browser.login(actors.owner);
        yield* browser.use("Open settings", (page) => page.goto(settings));
        yield* browser.use("General shows the organization name", (page) =>
          page.getByRole("heading", { name: "Organization name", exact: true }).waitFor(),
        );
        expect(yield* selected("General")).toBe("true");
        expect(
          yield* browser.use("Members are not on General", (page) =>
            page.getByRole("table", { name: "Members", exact: true }).count(),
          ),
        ).toBe(0);

        yield* browser.use("Choose the Files tab", (page) =>
          page.getByRole("tab", { name: "Files", exact: true }).click(),
        );
        yield* browser.use("The Files tab shows the file lifetime", (page) =>
          page.getByRole("heading", { name: "Blob", exact: true }).waitFor(),
        );
        expect(yield* query).toBe("files");

        yield* browser.use("Load the Members tab directly", (page) =>
          page.goto(`${settings}?tab=members`),
        );
        yield* browser.use("The members list is shown", (page) =>
          page.getByRole("table", { name: "Members", exact: true }).waitFor(),
        );
        expect(yield* selected("Members")).toBe("true");

        yield* browser.use("Load an unknown tab", (page) => page.goto(`${settings}?tab=nonsense`));
        yield* browser.use("An unknown tab shows General", (page) =>
          page.getByRole("heading", { name: "Organization name", exact: true }).waitFor(),
        );
        expect(yield* selected("General")).toBe("true");

        yield* browser.use("Choose Task insights", (page) =>
          page.getByRole("tab", { name: "Task insights", exact: true }).click(),
        );
        yield* browser.use("Task insights are shown", (page) =>
          page.getByRole("heading", { name: "Task insights", exact: true }).waitFor(),
        );
        expect(yield* query).toBe("task-insights");

        yield* browser.login(actors.member);
        yield* browser.use("Open Task insights as a member", (page) =>
          page.goto(`${settings}?tab=task-insights`),
        );
        yield* browser.use("A member sees General instead", (page) =>
          page.getByRole("heading", { name: "Organization name", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("A member has no Task insights tab", (page) =>
            page.getByRole("tab", { name: "Task insights", exact: true }).count(),
          ),
        ).toBe(0);
        expect(
          yield* browser.use("A member still has Members", (page) =>
            page.getByRole("tab", { name: "Members", exact: true }).count(),
          ),
        ).toBe(1);
      }),
    ),
  );
});
