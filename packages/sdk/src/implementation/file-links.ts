/**
 * Short-lived links to user-content files. A link is a bearer URL: whoever holds it may do the one
 * thing it names, until it expires, without presenting any other credential. That makes it the
 * right shape for handing a file to a browser, a download manager or another service, and it is
 * minted only by a caller the product has already authorized.
 *
 * A token is `payload.mac`. The payload is a JSON array binding the operation, the owner, the
 * file (for a download) or the limits (for an upload), the user it was issued for and its expiry;
 * the mac is an HMAC-SHA256 over the payload text under a key derived from the executor's own
 * secret, so no new secret exists and rotating the executor's key invalidates every link. A token
 * proves only that this host issued it: redeeming it still checks the file and the issuing user's
 * current access, so removing a member stops their links at once.
 */
import { Clock, Effect, Redacted, Schema } from "effect";
import { Base64Url, Hex } from "effect/encoding";
import { safeContentType } from "./file-handles.ts";

/** The shortest, default and longest lifetime of a link. Requests outside the range are clamped. */
export const minFileLinkSeconds = 60;
export const defaultFileLinkSeconds = 15 * 60;
export const maxFileLinkSeconds = 24 * 60 * 60;

/** Domain separation: no other signature in this product is over a payload that starts like this. */
const label = "executor file link";
const keyLabel = "executor file link v1";
const version = 1;

const Payload = Schema.Tuple([
  Schema.Literal(label),
  Schema.Literal(version),
  Schema.Literals(["get", "put"]),
  /** The owner of the file, as the SDK names owners. */
  Schema.String,
  /** The handle a download names. */
  Schema.NullOr(Schema.String),
  /** The bytes a download names, so a retired and recreated handle can never serve other bytes. */
  Schema.NullOr(Schema.String),
  /** The user the link was issued for, or the app that issued it when no user was present. */
  Schema.String,
  /** Expiry, in milliseconds since the epoch. */
  Schema.Int,
  /** The file name a download suggests. */
  Schema.NullOr(Schema.String),
  /** The content type an upload stores, when the issuer fixed it. */
  Schema.NullOr(Schema.String),
  /** The most bytes an upload may hold, when the issuer lowered the host's limit. */
  Schema.NullOr(Schema.Int),
]);
const EncodedPayload = Schema.fromJsonString(Payload);

/** What a verified token grants. */
export interface FileLinkClaims {
  readonly operation: "get" | "put";
  readonly owner: string;
  readonly id: string | undefined;
  readonly sha256: string | undefined;
  /** `user:<id>` for a person, `app:<id>` for an app that minted the link without one. */
  readonly subject: string;
  readonly expiresAt: number;
  readonly filename: string | undefined;
  readonly contentType: string | undefined;
  readonly maxBytes: number | undefined;
}

/** The token is not one this host issued, or it has expired, or it names another operation. */
export class FileLinkInvalid extends Schema.TaggedError<FileLinkInvalid>()("FileLinkInvalid", {
  reason: Schema.Literals(["malformed", "signature", "expired", "operation"]),
}) {}

/** A signed link and when it stops working. */
export interface IssuedFileLink {
  readonly url: string;
  readonly expiresAt: string;
}

/** The signing and verifying half of file links, bound to a host's secret and public origin. */
export interface FileLinks {
  readonly signGet: (input: {
    readonly owner: string;
    readonly id: string;
    readonly sha256: string;
    readonly subject: string;
    readonly expiresInSeconds?: number | undefined;
    readonly filename?: string | undefined;
  }) => Effect.Effect<IssuedFileLink>;
  readonly signPut: (input: {
    readonly owner: string;
    readonly subject: string;
    readonly expiresInSeconds?: number | undefined;
    readonly contentType?: string | undefined;
    readonly maxBytes?: number | undefined;
  }) => Effect.Effect<IssuedFileLink>;
  /** The claims of a token this host issued for `operation` that has not expired. */
  readonly verify: (
    token: string,
    operation: "get" | "put",
  ) => Effect.Effect<FileLinkClaims, FileLinkInvalid>;
}

/** Where a host serves link redemptions, under its product origin. */
export const fileLinkPath = "/api/file-links/";

/** Upload links are shorter lived than download links: each redemption can store a whole file. */
export const maxUploadLinkSeconds = 60 * 60;
/** A longer filename claim would make a URL that proxies refuse. */
const maxFilenameLength = 200;

const clamp = (operation: "get" | "put", seconds: number | undefined) =>
  Math.min(
    operation === "put" ? maxUploadLinkSeconds : maxFileLinkSeconds,
    Math.max(minFileLinkSeconds, seconds ?? defaultFileLinkSeconds),
  );

/** The HMAC key for links, derived from the executor's 32-byte secret. */
const deriveKey = (secret: Redacted.Redacted<string>) =>
  Effect.promise(async () => {
    const raw = Hex.decode(Redacted.value(secret));
    if (raw._tag === "Failure") throw new Error("The executor secret is not hexadecimal");
    const root = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(raw.success),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const derived = await crypto.subtle.sign("HMAC", root, new TextEncoder().encode(keyLabel));
    return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
  });

/** Links under `origin`, signed with a key derived from `secret`. */
export const makeFileLinks = (options: {
  readonly secret: Redacted.Redacted<string>;
  readonly origin: string;
}): Effect.Effect<FileLinks> =>
  Effect.map(deriveKey(options.secret), (key) => {
    const text = new TextEncoder();
    const sign = (payload: typeof Payload.Type) =>
      Effect.promise(async () => {
        const encoded = Base64Url.encode(JSON.stringify(payload));
        const mac = await crypto.subtle.sign("HMAC", key, text.encode(encoded));
        return `${encoded}.${Base64Url.encode(new Uint8Array(mac))}`;
      });
    const issued = (
      operation: "get" | "put",
      claims: Pick<
        FileLinkClaims,
        "owner" | "id" | "sha256" | "subject" | "filename" | "contentType" | "maxBytes"
      >,
      expiresInSeconds: number | undefined,
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const expiresAt = now + clamp(operation, expiresInSeconds) * 1000;
        const token = yield* sign([
          label,
          version,
          operation,
          claims.owner,
          claims.id ?? null,
          claims.sha256 ?? null,
          claims.subject,
          expiresAt,
          claims.filename ?? null,
          claims.contentType ?? null,
          claims.maxBytes ?? null,
        ]);
        return {
          url: new URL(`${fileLinkPath}${token}`, options.origin).href,
          expiresAt: new Date(expiresAt).toISOString(),
        };
      });
    return {
      signGet: (input) =>
        issued(
          "get",
          {
            owner: input.owner,
            id: input.id,
            sha256: input.sha256,
            subject: input.subject,
            filename: input.filename?.slice(0, maxFilenameLength),
            contentType: undefined,
            maxBytes: undefined,
          },
          input.expiresInSeconds,
        ),
      signPut: (input) =>
        issued(
          "put",
          {
            owner: input.owner,
            id: undefined,
            sha256: undefined,
            subject: input.subject,
            filename: undefined,
            contentType:
              input.contentType === undefined ? undefined : safeContentType(input.contentType),
            maxBytes: input.maxBytes,
          },
          input.expiresInSeconds,
        ),
      verify: (token, operation) =>
        Effect.gen(function* () {
          const parts = token.split(".");
          const [encoded, mac] = parts;
          if (parts.length !== 2 || encoded === undefined || mac === undefined)
            return yield* new FileLinkInvalid({ reason: "malformed" });
          const signature = Base64Url.decode(mac);
          // Only the canonical spelling of the mac is accepted: one token, one string.
          if (signature._tag === "Failure" || Base64Url.encode(signature.success) !== mac)
            return yield* new FileLinkInvalid({ reason: "malformed" });
          const valid = yield* Effect.promise(() =>
            crypto.subtle.verify(
              "HMAC",
              key,
              Uint8Array.from(signature.success),
              text.encode(encoded),
            ),
          );
          if (!valid) return yield* new FileLinkInvalid({ reason: "signature" });
          const payload = yield* Base64Url.decodeString(encoded).pipe(
            Effect.fromResult,
            Effect.flatMap(Schema.decodeUnknownEffect(EncodedPayload)),
            Effect.mapError(() => new FileLinkInvalid({ reason: "malformed" })),
          );
          const [
            ,
            ,
            found,
            owner,
            id,
            sha256,
            subject,
            expiresAt,
            filename,
            contentType,
            maxBytes,
          ] = payload;
          if ((yield* Clock.currentTimeMillis) >= expiresAt)
            return yield* new FileLinkInvalid({ reason: "expired" });
          if (found !== operation) return yield* new FileLinkInvalid({ reason: "operation" });
          return {
            operation: found,
            owner,
            id: id ?? undefined,
            sha256: sha256 ?? undefined,
            subject,
            expiresAt,
            filename: filename ?? undefined,
            contentType: contentType ?? undefined,
            maxBytes: maxBytes ?? undefined,
          };
        }),
    } satisfies FileLinks;
  });
