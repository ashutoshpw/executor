/**
 * OAuth declarations frozen for host protocol 14: `./oauth-6.ts`'s with `pkce: false` on a declared
 * authorization endpoint. The module imports only `effect`, `./oauth.ts` and `./oauth-6.ts`, so no
 * change elsewhere in the repository can alter it.
 */
import { Schema } from "effect";
import {
  declaredAuthorizationQuery,
  HttpUrl,
  type OAuthClientAuth,
  oauthOptions,
} from "./oauth.ts";
import { OAuth2Config as PreviousConfig } from "./oauth-6.ts";

/**
 * Signing in without PKCE leaves the code bound to the client by its secret alone, so only a
 * method that requires a secret may declare it.
 */
const declaredPkce = Schema.makeFilter(
  (config: { readonly pkce?: false; readonly tokenEndpointAuthMethod?: OAuthClientAuth }) =>
    config.pkce === false &&
    (config.tokenEndpointAuthMethod === undefined || config.tokenEndpointAuthMethod === "none")
      ? {
          path: ["pkce"],
          issue:
            "pkce: false requires tokenEndpointAuthMethod client_secret_post, client_secret_basic or client_secret_basic_raw.",
        }
      : undefined,
);

/**
 * OAuth endpoints and protocol choices. Omitted grant means authorization code; clients remain
 * host-owned. Declared endpoints may name an RFC 7009 `revocationUrl`; discovery reads the
 * server's `revocation_endpoint` metadata instead.
 */
export const OAuth2Config = Schema.Union([
  PreviousConfig.members[0],
  Schema.Struct({
    ...oauthOptions,
    /** Its query is kept; it cannot set protocol parameters or repeat `authorizationParams`. */
    authorizationUrl: HttpUrl,
    tokenUrl: HttpUrl,
    revocationUrl: Schema.optionalKey(HttpUrl),
    scopes: Schema.Array(Schema.String),
    /** RFC 8414 issuer identifier. Declared issuers are checked against the callback's `iss`. */
    issuer: Schema.optionalKey(HttpUrl),
    /**
     * `false` signs in without PKCE, for a service whose token endpoint refuses a confidential
     * client's `code_verifier`. Requires a secret client method.
     */
    pkce: Schema.optionalKey(Schema.Literal(false)),
    discover: Schema.optionalKey(Schema.Never),
    authorizationServerMetadataUrl: Schema.optionalKey(Schema.Never),
  }).check(declaredAuthorizationQuery, declaredPkce),
  PreviousConfig.members[2],
  PreviousConfig.members[3],
]);
export type OAuth2Config = typeof OAuth2Config.Type;
