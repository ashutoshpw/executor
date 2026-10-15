---
"apps": patch
---

`oauth2({ grant: "jwt_bearer", tokenUrl, scopes, subject })` declares a provider
that signs in with a service account key, such as a Google service account. The
person connecting pastes the key; the host signs an RFC 7523 assertion and
exchanges it for an access token, so the key never reaches app code. This is host
protocol 14: bundles of protocol 13 and earlier cannot declare the method, and the
host sends them an account of such a provider as the `secrets` method it behaves as.
