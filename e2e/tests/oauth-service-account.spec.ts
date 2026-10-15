import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource, Inventory } from "../support/contracts.ts";
import {
  serviceAccountEmail,
  serviceAccountIssuer,
  serviceAccountKeyId,
} from "../support/service-account-issuer.ts";
import { linkedAccountIds, connectionsPath } from "../support/app-accounts.ts";
import { settleWebhookSources } from "../support/webhook-sources.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
import { managementApp } from "../support/management-app.ts";

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  account: Schema.Struct({ id: Schema.String, label: Schema.String }),
});
const Read = Schema.Struct({
  authenticated: Schema.Boolean,
  generation: Schema.Number,
  fields: Schema.Array(Schema.String),
});
const Failure = Schema.Struct({ _tag: Schema.String });

const scopes = ["https://example.test/scope.read", "https://example.test/scope.write"];
const delegate = "delegate@example.test";
/** The grant type RFC 7523 section 2.1 names. */
const jwtBearer = "urn:ietf:params:oauth:grant-type:jwt-bearer";

layer(HostedLive, { excludeTestServices: true })("Service account OAuth", (it) => {
  /** An app whose provider signs in with a service account key; `subject` says what the form asks. */
  const deployApp = (
    tokenUrl: string,
    origin: string,
    subject: "optional" | "required",
    name: string,
  ) =>
    Effect.gen(function* () {
      const api = yield* Api,
        actors = yield* Actors;
      const prefix = `/api/organizations/${actors.organization.id}`;
      const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: `${name} ${randomUUID().slice(0, 8)}`,
        files: [
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, oauth2, query, object, router } from "apps";
const service=defineProvider({name:"Workspace",auth:{serviceAccount:oauth2({grant:"jwt_bearer",tokenUrl:${JSON.stringify(tokenUrl)},scopes:${JSON.stringify(scopes)},subject:${JSON.stringify(subject)}})}});
export default defineApp({user: { accounts:{service} }},async({user: { accounts }})=>({tools: router({
  read:query({input:object({})},async({fetch})=>{const result=await fetch(${JSON.stringify(origin + "/resource")},{headers:{authorization:"Bearer "+accounts.service.fields.access_token}});return {...(await result.json()),fields:Object.keys(accounts.service.fields)};}),
})}));`,
          },
          appsManifest,
        ],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const app = yield* body(Resource, response);
      yield* Effect.addFinalizer(() =>
        api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
      );
      return app;
    });

  /** Start a connection for the app's service requirement and submit the pasted key. */
  const connect = (appId: string, payload: Record<string, unknown>, account?: string) =>
    Effect.gen(function* () {
      const api = yield* Api,
        actors = yield* Actors;
      const prefix = `/api/organizations/${actors.organization.id}`;
      const connection = yield* body(
        Resource,
        yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(`${prefix}/apps/${appId}`, "user", "service"),
          account === undefined ? {} : { account },
        ),
      );
      const path = `${prefix}/connections/${connection.id}/oauth/start`;
      return {
        path,
        started: yield* api.request(actors.owner, "POST", path, {
          method: "serviceAccount",
          ...payload,
        }),
      };
    });

  it.effect(scenarios.oauthServiceAccount.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const issuer = yield* serviceAccountIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const app = yield* deployApp(issuer.tokenUrl, issuer.origin, "optional", "Service account");
        const call = () =>
          api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/tools/call`, {
            tool: "read",
            kind: "query",
            input: {},
          });

        const { path, started } = yield* connect(app.id, {
          label: "Reporting",
          client: { serviceAccountKey: issuer.keyJson(), subject: delegate },
        });
        // Connections belong to their owner; another member cannot complete one.
        expect(
          (yield* api.request(actors.member, "POST", path, {
            method: "serviceAccount",
            client: { serviceAccountKey: issuer.keyJson() },
          })).status,
        ).toBe(403);
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const completed = yield* body(Completed, started);
        expect(completed.account.label).toBe("Reporting");
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${completed.account.id}`)
            .pipe(Effect.orDie),
        );

        // One request carried a signed assertion, and nothing else: the key is the credential.
        const connected = yield* issuer.metrics;
        expect(connected.requests).toBe(1);
        expect(connected.observed).toEqual([
          {
            grantType: jwtBearer,
            fields: ["assertion", "grant_type"],
            contentType: "application/x-www-form-urlencoded",
            authenticatedClient: false,
            signatureValid: true,
            alg: "RS256",
            typ: "JWT",
            kid: serviceAccountKeyId,
            iss: serviceAccountEmail,
            sub: delegate,
            scope: scopes.join(" "),
            aud: issuer.tokenUrl,
            issuedSkew: expect.any(Number),
            lifetime: expect.any(Number),
          },
        ]);
        const [assertion] = connected.observed;
        expect(assertion?.issuedSkew).toBeLessThanOrEqual(60);
        expect(assertion?.lifetime).toBeGreaterThan(0);
        expect(assertion?.lifetime).toBeLessThanOrEqual(3600);

        // The app sees the access token and nothing of the key, and the token is cached.
        const shown: unknown[] = [started.body];
        for (let attempt = 0; attempt < 2; attempt++) {
          const read = yield* call();
          expect(read.status, JSON.stringify(read.body)).toBe(200);
          const value = yield* body(Read, read);
          expect(value.authenticated).toBe(true);
          expect(value.generation).toBe(1);
          expect(value.fields).toEqual(["access_token"]);
          shown.push(read.body);
        }
        expect((yield* issuer.metrics).requests).toBe(1);
        shown.push(
          (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${completed.account.id}`))
            .body,
          (yield* api.request(actors.owner, "GET", `${prefix}/inventory`)).body,
        );
        for (const marker of [...issuer.privateKeyMarkers, "eyJ"])
          expect(JSON.stringify(shown).includes(marker), marker).toBe(false);
        // Connecting from the app linked the account to it, once.
        expect(yield* linkedAccountIds(actors.owner, `${prefix}/apps/${app.id}`)).toEqual([
          completed.account.id,
        ]);
        yield* settleWebhookSources(actors.owner, `${prefix}/apps/${app.id}`, (sources) =>
          sources.some(
            (source) => source.account === completed.account.id && source.status !== "pending",
          ),
        );

        // A token this short is inside the host's renewal window as soon as it is saved. A
        // reconnect that enters no key signs in again with the key the grant keeps.
        yield* issuer.configure({ expiresIn: 20 });
        const reconnected = yield* connect(app.id, {}, completed.account.id);
        expect(reconnected.started.status, JSON.stringify(reconnected.started.body)).toBe(200);
        expect((yield* body(Completed, reconnected.started)).account).toEqual(completed.account);
        const beforeRenewal = yield* issuer.metrics;
        expect(beforeRenewal.requests).toBe(2);
        const renewed = yield* call();
        expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
        const value = yield* body(Read, renewed);
        expect(value.authenticated).toBe(true);
        expect(value.generation).toBeGreaterThan(beforeRenewal.generation);
        // The renewal signed a new assertion with the grant's key and the connection's user.
        const after = yield* issuer.metrics;
        expect(after.requests).toBeGreaterThan(beforeRenewal.requests);
        expect(after.observed.at(-1)).toMatchObject({
          signatureValid: true,
          grantType: jwtBearer,
          sub: delegate,
          scope: scopes.join(" "),
          aud: issuer.tokenUrl,
          authenticatedClient: false,
        });
        // A service that refuses the key for this client keeps the grant: the renewed token is
        // still valid, so the call's renewal ahead of expiry fails and the call uses that token.
        yield* issuer.configure({ reject: "unauthorized_client" });
        const requests = (yield* issuer.metrics).requests;
        const kept = yield* call();
        expect(kept.status, JSON.stringify(kept.body)).toBe(200);
        expect((yield* body(Read, kept)).generation).toBe(value.generation);
        expect((yield* issuer.metrics).requests).toBe(requests + 1);
      }),
    ),
  );

  it.effect(scenarios.oauthServiceAccountErrors.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const issuer = yield* serviceAccountIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const optional = yield* deployApp(issuer.tokenUrl, issuer.origin, "optional", "Optional");
        const required = yield* deployApp(issuer.tokenUrl, issuer.origin, "required", "Required");
        const inventory = () =>
          Effect.gen(function* () {
            return yield* body(
              Inventory,
              yield* api.request(actors.owner, "GET", `${prefix}/inventory`),
            );
          });
        // The baseline must include the asynchronously provisioned personal account.
        yield* managementApp(actors.owner);
        const before = (yield* inventory()).accounts.map((account) => account.id).sort();
        const shown: unknown[] = [];
        const refused = (
          app: { readonly id: string },
          client: unknown,
          expected: Record<string, unknown>,
        ) =>
          Effect.gen(function* () {
            const { started } = yield* connect(app.id, { client });
            expect(started.status, JSON.stringify(started.body)).toBe(422);
            expect(started.body).toMatchObject({ _tag: "OAuthSetupFailed", ...expected });
            shown.push(started.body);
          });

        // Everything refused before a request is sent: the key is checked first.
        const entered = (text: string, subject?: string) => ({
          serviceAccountKey: text,
          ...(subject === undefined ? {} : { subject }),
        });
        for (const key of [
          "this is not a key",
          issuer.keyJson({ type: "authorized_user" }),
          issuer.keyJson({ privateKey: "pkcs1" }),
        ])
          yield* refused(optional, entered(key), { reason: "invalid_service_account_key" });
        yield* refused(
          optional,
          entered(issuer.keyJson({ tokenUri: "https://accounts.example.test/o/oauth2/token" })),
          { reason: "token_url_mismatch" },
        );
        yield* refused(required, entered(issuer.keyJson()), { reason: "subject_required" });
        // An OAuth client, the automatic client or nothing at all is not a key.
        yield* refused(optional, { clientId: "synthetic-client" }, { reason: "invalid_client" });
        yield* refused(optional, { automatic: true }, { reason: "invalid_client" });
        const none = yield* connect(optional.id, {});
        expect(none.started.status, JSON.stringify(none.started.body)).toBe(422);
        expect(none.started.body).toMatchObject({ reason: "invalid_client" });
        expect((yield* issuer.metrics).requests).toBe(0);

        // The service refuses what reaches it, and Executor reports its error code.
        yield* refused(optional, entered(issuer.keyJson({ privateKey: "unrelated" })), {
          reason: "token_exchange",
          cause: { stage: "jwtBearer", status: 400, providerError: "invalid_grant" },
        });
        yield* issuer.configure({ reject: "unauthorized_client" });
        yield* refused(optional, entered(issuer.keyJson(), delegate), {
          reason: "token_exchange",
          cause: { stage: "jwtBearer", status: 400, providerError: "unauthorized_client" },
        });
        yield* issuer.configure({ reject: "server_error" });
        yield* refused(optional, entered(issuer.keyJson()), { reason: "service_unavailable" });
        expect((yield* issuer.metrics).requests).toBe(3);

        // No refusal saved an account, and none repeated the key or the assertion.
        expect((yield* inventory()).accounts.map((account) => account.id).sort()).toEqual(before);
        const text = JSON.stringify(shown);
        for (const marker of [...issuer.privateKeyMarkers, "eyJ"])
          expect(text.includes(marker), marker).toBe(false);
      }),
    ),
  );

  it.effect(scenarios.oauthServiceAccountReconnect.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const issuer = yield* serviceAccountIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const app = yield* deployApp(issuer.tokenUrl, issuer.origin, "optional", "Revoked key");
        // The token is inside the renewal window as soon as it is saved.
        yield* issuer.configure({ expiresIn: 20 });
        const { started } = yield* connect(app.id, {
          client: { serviceAccountKey: issuer.keyJson() },
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const completed = yield* body(Completed, started);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${completed.account.id}`)
            .pipe(Effect.orDie),
        );
        // The provider no longer accepts the key, such as one an administrator disabled.
        yield* issuer.configure({ reject: "invalid_grant" });
        const refused = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/apps/${app.id}/tools/call`,
          { tool: "read", kind: "query", input: {} },
        );
        expect(refused.status, JSON.stringify(refused.body)).toBe(409);
        expect((yield* body(Failure, refused))._tag).toBe("OAuthReconnectRequired");
        expect(JSON.stringify(refused.body).includes("PRIVATE KEY")).toBe(false);
      }),
    ),
  );
});
