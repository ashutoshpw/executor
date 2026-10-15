/**
 * Service account keys and RFC 7523 assertions. A key is the JSON file a provider such as Google
 * issues for a service account. The host reads the few fields signing needs, signs with WebCrypto
 * and sends only the assertion. Nothing here names a value in an error: failures carry a reason
 * and, at most, the name of the field that was wrong.
 */
import { Effect, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { OAuthJwtBearerKey } from "../contracts/oauth.ts";

/** The longest key file Executor reads, in characters. Real keys are about 2.4 KiB. */
export const maxServiceAccountKeyLength = 16 * 1024;

/** An RFC 7523 assertion's default lifetime, below the hour providers allow at most. */
export const assertionLifetimeSeconds = 3300;

export class ServiceAccountKeyInvalid extends Schema.TaggedError<ServiceAccountKeyInvalid>()(
  "ServiceAccountKeyInvalid",
  {
    reason: Schema.Literals([
      "too_large",
      "not_json",
      "wrong_type",
      "missing_field",
      "not_pkcs8",
      "unsupported_key",
      "token_uri_invalid",
      "signing_failed",
    ]),
    /** The name of the key file's field, never its value. */
    field: Schema.optional(Schema.String),
  },
) {}

const invalid = (reason: ServiceAccountKeyInvalid["reason"], field?: string) =>
  new ServiceAccountKeyInvalid({ reason, ...(field === undefined ? {} : { field }) });

/** A pasted key file, reduced to what signing needs plus the token endpoint it names. */
export type ParsedServiceAccountKey = OAuthJwtBearerKey & { readonly tokenUri: string };

const stringField = (file: Readonly<Record<string, unknown>>, field: string) => {
  const value = file[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

/**
 * Read a service account key file. Fields Executor does not sign with, such as the project and
 * client IDs, are dropped here and never stored.
 */
export const parseServiceAccountKey = (
  text: string,
): Effect.Effect<ParsedServiceAccountKey, ServiceAccountKeyInvalid> =>
  Effect.gen(function* () {
    if (text.length > maxServiceAccountKeyLength) return yield* invalid("too_large");
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => invalid("not_json"),
    });
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return yield* invalid("not_json");
    const file: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(parsed));
    if (file["type"] !== "service_account") return yield* invalid("wrong_type", "type");
    const clientEmail = stringField(file, "client_email");
    if (clientEmail === undefined) return yield* invalid("missing_field", "client_email");
    const privateKey = stringField(file, "private_key");
    if (privateKey === undefined) return yield* invalid("missing_field", "private_key");
    const tokenUri = stringField(file, "token_uri");
    if (tokenUri === undefined) return yield* invalid("missing_field", "token_uri");
    if (!URL.canParse(tokenUri)) return yield* invalid("token_uri_invalid", "token_uri");
    // RSA PKCS#1 keys (`BEGIN RSA PRIVATE KEY`) and encrypted ones are not what providers issue.
    if (!privateKey.includes("-----BEGIN PRIVATE KEY-----"))
      return yield* invalid("not_pkcs8", "private_key");
    const privateKeyId = stringField(file, "private_key_id");
    return {
      clientEmail,
      privateKey,
      ...(privateKeyId === undefined ? {} : { privateKeyId }),
      tokenUri,
    };
  });

const pemBody = (pem: string) =>
  pem
    .replace(/-----BEGIN PRIVATE KEY-----/u, "")
    .replace(/-----END PRIVATE KEY-----/u, "")
    .replace(/\s+/gu, "");

const rsaSigning = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** The signing key for a PKCS#8 PEM; only RSA keys sign RS256. */
export const importSigningKey = (pem: string): Effect.Effect<CryptoKey, ServiceAccountKeyInvalid> =>
  Effect.gen(function* () {
    const der = Base64.decode(pemBody(pem));
    if (der._tag === "Failure") return yield* invalid("not_pkcs8", "private_key");
    return yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey("pkcs8", new Uint8Array(der.success), rsaSigning, false, ["sign"]),
      catch: () => invalid("unsupported_key", "private_key"),
    });
  });

const encoder = new TextEncoder();
const base64Url = (bytes: Uint8Array) =>
  Base64.encode(bytes).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
const json = (value: unknown) => base64Url(encoder.encode(JSON.stringify(value)));

/** A signed RS256 assertion (RFC 7523 section 3) for the service account. */
export const signAssertion = (input: {
  readonly key: CryptoKey;
  readonly clientEmail: string;
  readonly privateKeyId?: string | undefined;
  /** The user to act for, when the key has domain-wide delegation. */
  readonly subject?: string | undefined;
  readonly scope: string;
  readonly audience: string;
  readonly nowSeconds: number;
  readonly lifetimeSeconds?: number | undefined;
}): Effect.Effect<string, ServiceAccountKeyInvalid> =>
  Effect.gen(function* () {
    const lifetime = Math.min(input.lifetimeSeconds ?? assertionLifetimeSeconds, 3600);
    const header = json({
      alg: "RS256",
      typ: "JWT",
      ...(input.privateKeyId === undefined ? {} : { kid: input.privateKeyId }),
    });
    const claims = json({
      iss: input.clientEmail,
      ...(input.subject === undefined ? {} : { sub: input.subject }),
      scope: input.scope,
      aud: input.audience,
      iat: input.nowSeconds,
      exp: input.nowSeconds + lifetime,
    });
    const signed = `${header}.${claims}`;
    const signature = yield* Effect.tryPromise({
      try: () => crypto.subtle.sign(rsaSigning.name, input.key, encoder.encode(signed)),
      catch: () => invalid("signing_failed"),
    });
    return `${signed}.${base64Url(new Uint8Array(signature))}`;
  });
