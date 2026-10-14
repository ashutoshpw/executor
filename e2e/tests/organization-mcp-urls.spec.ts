/** Agent handoffs inside an organization name it and give its own MCP URL, not the bare /mcp. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { Api } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Organization MCP URLs", (it) => {
  it.effect(scenarios.organizationMcpUrls.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const slug = `labs-${randomUUID().slice(0, 8)}`;
        const name = `Labs ${slug}`;
        const created = yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
          name,
          slug,
          keepCurrentActiveOrganization: true,
        });
        expect(created.status).toBe(200);
        const path = `/org/${slug}/mcp`;
        // The URL ends at the organization path: a bare /mcp must not appear in its place.
        const expectOrganization = (text: string) => {
          expect(text).toContain(name);
          expect(text).toContain(slug);
          expect(text).toContain(path);
          expect(text).not.toMatch(/\/\/[^/\s]+\/mcp(?![\w/-])/);
        };

        yield* browser.login(actors.owner);
        yield* browser.use("Open Connect a service", (page) =>
          page.goto(`/org/${slug}/apps/add/custom`),
        );
        const prompt = yield* browser.use("Read the agent prompt", (page) =>
          page.getByRole("region", { name: "Any other service" }).textContent(),
        );
        expectOrganization(prompt ?? "");
        expect(prompt).toContain("connection is for a different organization");

        yield* browser.use("Open Connect", (page) => page.goto(`/org/${slug}/connect`));
        yield* browser.use("Open the prompt tab", (page) =>
          page.getByRole("tab", { name: "Prompt", exact: true }).click(),
        );
        const install = yield* browser.use("Read the install prompt", (page) =>
          page.getByRole("tabpanel", { name: "Prompt" }).textContent(),
        );
        expectOrganization(install ?? "");
        yield* browser.use("Open the MCP URL tab", (page) =>
          page.getByRole("tab", { name: "MCP URL", exact: true }).click(),
        );
        const url = yield* browser.use("Read the MCP URL", (page) =>
          page.getByRole("tabpanel", { name: "MCP URL" }).textContent(),
        );
        expect(url).toContain(path);
        // Each organization gets its own server entry, so adding one does not replace another.
        yield* browser.use("Open the command tab", (page) =>
          page.getByRole("tab", { name: "Command", exact: true }).click(),
        );
        const command = yield* browser.use("Read the install command", (page) =>
          page.getByRole("tabpanel", { name: "Command" }).textContent(),
        );
        expect(command).toContain(path);
        expect(command).toContain(`--name executor-${slug} -g`);
        yield* browser.use("Open the personal access token tab", (page) =>
          page.getByRole("tab", { name: "Personal access token", exact: true }).click(),
        );
        const token = yield* browser.use("Read the token configuration", (page) =>
          page.getByRole("tabpanel", { name: "Personal access token" }).textContent(),
        );
        expect(token).toContain(`"executor-${slug}"`);
        expect(token).toContain(path);
      }),
    ),
  );
});
