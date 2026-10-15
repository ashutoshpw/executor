/** An organization's own MCP URL is a complete OAuth resource: discovery, consent and tokens agree. */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Layer, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { rawRequest, targetHosts } from "../support/role-hosts.ts";

const ProtectedResource = Schema.fromJsonString(Schema.Struct({ resource: Schema.String }));
const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const post = (token?: Redacted.Redacted<string>) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(token === undefined ? {} : { authorization: `Bearer ${Redacted.value(token)}` }),
  },
  body: JSON.stringify(listTools),
});

layer(HostedLive, { excludeTestServices: true })("MCP organization OAuth", (it) => {
  it.effect(scenarios.mcpOrganizationOAuth.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          oauth = yield* McpOAuth,
          mcp = yield* McpClient,
          target = yield* Target;
        const resourceOrigin = targetHosts(target).mcp;
        const slug = actors.organization.slug;
        const path = `/org/${slug}/mcp`;
        const wellKnown = "/.well-known/oauth-protected-resource";
        const resourceOf = (url: string) =>
          rawRequest(url).pipe(
            Effect.flatMap((response) =>
              response.status === 200
                ? Schema.decodeUnknownEffect(ProtectedResource)(response.text)
                : Effect.succeed({ resource: `HTTP ${response.status}` }),
            ),
            Effect.map((metadata) => metadata.resource),
          );

        yield* evidence.step(
          "The organization URL's challenge and metadata name the organization URL",
          Effect.gen(function* () {
            const challenge = yield* rawRequest(`${resourceOrigin}${path}`, post());
            expect(challenge.status).toBe(401);
            expect(challenge.challenge).toContain(
              `resource_metadata="${resourceOrigin}${wellKnown}${path}?elicitation_mode=model"`,
            );
            // The bare URL's challenge and metadata are unchanged.
            const bare = yield* rawRequest(`${resourceOrigin}/mcp`, post());
            expect(bare.status).toBe(401);
            expect(bare.challenge).toContain(
              `resource_metadata="${resourceOrigin}${wellKnown}/mcp?elicitation_mode=model"`,
            );
            expect(yield* resourceOf(`${resourceOrigin}${wellKnown}${path}`)).toBe(
              `${resourceOrigin}${path}`,
            );
            expect(
              yield* resourceOf(`${resourceOrigin}${wellKnown}${path}?elicitation_mode=browser`),
            ).toBe(`${resourceOrigin}${path}?elicitation_mode=browser`);
            expect(yield* resourceOf(`${resourceOrigin}${wellKnown}/mcp`)).toBe(
              `${resourceOrigin}/mcp`,
            );
            expect(
              yield* resourceOf(`${resourceOrigin}${wellKnown}/mcp?elicitation_mode=browser`),
            ).toBe(`${resourceOrigin}/mcp?elicitation_mode=browser`);
            // Malformed handles and parameters are refused, never read as the bare URL.
            for (const refused of [
              `${wellKnown}/org/Bad.Slug/mcp`,
              `${wellKnown}${path}?elicitation_mode=other`,
            ])
              expect(yield* resourceOf(`${resourceOrigin}${refused}`), refused).toBe("HTTP 400");
          }),
        );

        yield* browser.login(actors.owner);
        const grant = yield* evidence.step(
          "A client authorizes the organization URL as its resource",
          oauth.authorizeOrganization(slug, resourceOrigin),
        );
        expect(grant.resource).toBe(`${resourceOrigin}${path}`);
        const token = Redacted.make(Redacted.value(grant.tokens).access_token);
        const client = yield* mcp.connect(token, "organization-url", {
          origin: resourceOrigin,
          path,
        });
        const listed = yield* client.use("The organization URL accepts its grant", (client) =>
          client.listTools(),
        );
        expect(listed.tools.map((tool) => tool.name)).toContain("execute");

        yield* evidence.step(
          "The grant serves no other organization's URL and not the bare URL",
          Effect.gen(function* () {
            const other = `other-${randomUUID().slice(0, 8)}`;
            const created = yield* api.request(
              actors.owner,
              "POST",
              "/api/auth/organization/create",
              { name: `Other ${other}`, slug: other, keepCurrentActiveOrganization: true },
            );
            expect(created.status).toBe(200);
            expect(
              (yield* rawRequest(`${resourceOrigin}/org/${other}/mcp`, post(token))).status,
            ).toBe(403);
            expect(
              Exit.isFailure(
                yield* Effect.exit(
                  mcp.connect(token, "other-organization", {
                    origin: resourceOrigin,
                    path: `/org/${other}/mcp`,
                  }),
                ),
              ),
            ).toBe(true);
            expect((yield* rawRequest(`${resourceOrigin}/mcp`, post(token))).status).toBe(403);
          }),
        );

        yield* evidence.step(
          "A grant for the bare URL keeps serving the organization URL",
          Effect.gen(function* () {
            const bare = yield* oauth.authorize;
            const bareToken = Redacted.make(Redacted.value(bare.tokens).access_token);
            const bareClient = yield* mcp.connect(bareToken, "bare-at-organization-url", {
              origin: resourceOrigin,
              path,
            });
            const tools = yield* bareClient.use(
              "The organization URL accepts a bare grant",
              (client) => client.listTools(),
            );
            expect(tools.tools.map((tool) => tool.name)).toContain("execute");
            yield* oauth.revoke(bare);
          }),
        );
        yield* evidence.step(
          "An organization that does not exist is not a resource",
          Effect.gen(function* () {
            const callback = "http://127.0.0.1:9/callback";
            const registered = yield* api.request(
              yield* api.session(),
              "POST",
              "/api/auth/oauth2/register",
              {
                client_name: "Unknown organization client",
                redirect_uris: [callback],
                token_endpoint_auth_method: "none",
                grant_types: ["authorization_code"],
                response_types: ["code"],
              },
            );
            const { client_id } = yield* body(
              Schema.Struct({ client_id: Schema.NonEmptyString }),
              registered,
            );
            const query = new URLSearchParams({
              response_type: "code",
              client_id,
              redirect_uri: callback,
              code_challenge: "x".repeat(43),
              code_challenge_method: "S256",
              scope: "mcp",
              resource: `${resourceOrigin}/org/missing-${randomUUID().slice(0, 8)}/mcp`,
              state: "s",
            });
            const refused = yield* rawRequest(
              `${targetHosts(target).browser}/api/auth/oauth2/authorize?${query}`,
            );
            expect(refused.location ?? refused.text).toContain("invalid_target");
          }),
        );
        yield* oauth.revoke(grant);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
