/**
 * A real loopback token service for service account keys (RFC 7523). It verifies each assertion's
 * RS256 signature with the key pair it generated and records what the assertion said. It exposes
 * protocol observations, never the assertion, the private key or an access token.
 */
import { createServer } from "node:http";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Clock, Deferred, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

/** What the service read from one token request. */
export interface ObservedAssertion {
  readonly grantType: string | null;
  /** The request's form field names, so a stray `client_id` or `scope` shows. */
  readonly fields: ReadonlyArray<string>;
  readonly contentType: string | undefined;
  /** Whether the request carried client authentication of its own (the key is the credential). */
  readonly authenticatedClient: boolean;
  readonly signatureValid: boolean;
  readonly alg: unknown;
  readonly typ: unknown;
  readonly kid: unknown;
  readonly iss: unknown;
  readonly sub: unknown;
  readonly scope: unknown;
  readonly aud: unknown;
  /** Seconds between the assertion's `iat` and the service's clock. */
  readonly issuedSkew: number | undefined;
  /** Seconds the assertion is valid for. */
  readonly lifetime: number | undefined;
}

export const serviceAccountEmail = "synthetic-reader@synthetic-project.iam.example.test";
export const serviceAccountKeyId = "synthetic-key-id-1";

const pair = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

const decodeSegment = (segment: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : {};
  } catch {
    return {};
  }
};

/** Token issuance and resource access use actual HTTP; renewal is visible through the token generation. */
export const serviceAccountIssuer = Effect.gen(function* () {
  const address = yield* Deferred.make<string>();
  const trusted = pair();
  const unrelated = pair();
  const publicKey = createPublicKey(trusted.publicKey);
  let expiresIn = 3600;
  let reject: "invalid_grant" | "unauthorized_client" | "server_error" | undefined;
  let requests = 0;
  let generation = 0;
  const tokens = new Map<string, { generation: number; expiresAt: number }>();
  const observations: ObservedAssertion[] = [];
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "POST",
      "/token",
      Effect.gen(function* () {
        requests++;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const parameters = new URLSearchParams(yield* request.text);
        const now = yield* Clock.currentTimeMillis;
        const [header = "", claims = "", signature = ""] = (
          parameters.get("assertion") ?? ""
        ).split(".");
        const head = decodeSegment(header);
        const body = decodeSegment(claims);
        const iat = typeof body["iat"] === "number" ? body["iat"] : undefined;
        const exp = typeof body["exp"] === "number" ? body["exp"] : undefined;
        const observed: ObservedAssertion = {
          grantType: parameters.get("grant_type"),
          fields: [...parameters.keys()].sort(),
          contentType: request.headers["content-type"]?.split(";")[0]?.trim(),
          authenticatedClient:
            request.headers.authorization !== undefined ||
            parameters.has("client_id") ||
            parameters.has("client_secret"),
          signatureValid:
            signature !== "" &&
            verify(
              "RSA-SHA256",
              Buffer.from(`${header}.${claims}`),
              publicKey,
              Buffer.from(signature, "base64url"),
            ),
          alg: head["alg"],
          typ: head["typ"],
          kid: head["kid"],
          iss: body["iss"],
          sub: body["sub"],
          scope: body["scope"],
          aud: body["aud"],
          issuedSkew: iat === undefined ? undefined : Math.abs(iat - Math.floor(now / 1000)),
          lifetime: iat === undefined || exp === undefined ? undefined : exp - iat,
        };
        observations.push(observed);
        if (reject === "server_error")
          return yield* HttpServerResponse.json({ error: "server_error" }, { status: 503 });
        if (reject !== undefined)
          return yield* HttpServerResponse.json(
            { error: reject, error_description: "Rejected by the synthetic token service." },
            { status: 400 },
          );
        if (
          observed.grantType !== "urn:ietf:params:oauth:grant-type:jwt-bearer" ||
          !observed.signatureValid ||
          observed.alg !== "RS256"
        )
          return yield* HttpServerResponse.json(
            { error: "invalid_grant", error_description: "Invalid JWT Signature." },
            { status: 400 },
          );
        const token = `synthetic-sa-${++generation}`;
        tokens.set(`Bearer ${token}`, { generation, expiresAt: now + expiresIn * 1000 });
        return yield* HttpServerResponse.json({
          access_token: token,
          token_type: "Bearer",
          expires_in: expiresIn,
        });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/resource",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const issued = tokens.get(request.headers.authorization ?? "");
        return yield* HttpServerResponse.json({
          authenticated:
            issued !== undefined && issued.expiresAt > (yield* Clock.currentTimeMillis),
          generation: issued?.generation ?? 0,
        });
      }),
    ),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Token fixture needs a TCP listener");
  const origin = `http://127.0.0.1:${server.address.port}`;
  yield* Deferred.succeed(address, origin);
  const tokenUrl = `${origin}/token`;
  return {
    origin,
    tokenUrl,
    /**
     * A key file as a provider issues it. `privateKey: "unrelated"` is a valid key the service does
     * not trust; `pkcs1` is the same trusted key in RSA PKCS#1 form, which Executor refuses.
     */
    keyJson: (
      options: {
        readonly tokenUri?: string;
        readonly privateKey?: "trusted" | "unrelated" | "pkcs1";
        readonly type?: string;
      } = {},
    ) =>
      JSON.stringify({
        type: options.type ?? "service_account",
        project_id: "synthetic-project",
        private_key_id: serviceAccountKeyId,
        private_key:
          options.privateKey === "unrelated"
            ? unrelated.privateKey
            : options.privateKey === "pkcs1"
              ? "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKsynthetic\n-----END RSA PRIVATE KEY-----\n"
              : trusted.privateKey,
        client_email: serviceAccountEmail,
        client_id: "123456789",
        token_uri: options.tokenUri ?? tokenUrl,
        universe_domain: "example.test",
      }),
    /** The private key's PEM body, to prove it never appears anywhere Executor shows. */
    privateKeyMarkers: [
      "PRIVATE KEY",
      trusted.privateKey.split("\n")[1] ?? "",
      unrelated.privateKey.split("\n")[1] ?? "",
    ],
    configure: (input: { expiresIn?: number; reject?: typeof reject | "none" }) =>
      Effect.sync(() => {
        if (input.expiresIn !== undefined) expiresIn = input.expiresIn;
        if (input.reject !== undefined) reject = input.reject === "none" ? undefined : input.reject;
      }),
    metrics: Effect.sync(() => ({
      requests,
      generation,
      observed: observations.slice(),
    })),
  };
});
