/**
 * A self-host instance's operator SSO against the disposable identity provider. A self-host
 * instance requires HTTPS for its provider, so the provider serves a certificate made for this
 * scenario, and only the instance and this helper trust it.
 */
import { Effect, FileSystem, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { driver } from "./platform.ts";
import { cookieOf } from "./self-host-instance.ts";

/** The client the provider issues tokens to; see `apps/hosted/testing/sso-idp.ts`. */
const clientId = "synthetic-sso-client";
const clientSecret = "synthetic-sso-secret";
/** The only address domain the instance admits. */
export const ssoDomain = "sso.example.test";

/** Start the provider over HTTPS and describe how an instance reaches it. */
export const selfHostSsoProvider = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-self-host-sso-" });
  const key = `${directory}/key.pem`,
    certificate = `${directory}/cert.pem`;
  yield* processes.string(
    ChildProcess.make(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        certificate,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { stderr: "pipe" },
    ),
  );
  yield* processes.spawn(
    ChildProcess.make(
      "node",
      [
        "apps/hosted/testing/sso-idp.ts",
        "--directory",
        directory,
        "--tls-key",
        key,
        "--tls-certificate",
        certificate,
      ],
      {
        env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
        extendEnv: false,
        stdout: "ignore",
        stderr: "ignore",
        forceKillAfter: "5 seconds",
      },
    ),
  );
  const { origin, plainOrigin } = yield* fs
    .readFileString(`${directory}/sso-idp.json`)
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({ origin: Schema.String, plainOrigin: Schema.String }),
          ),
        ),
      ),
      Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
    );
  const StartedSignIn = Schema.Struct({ url: Schema.optionalKey(Schema.String) });
  return {
    /** What an operator sets so an instance admits people from the provider. */
    environment: {
      SSO_DISCOVERY_URL: `${origin}/.well-known/openid-configuration`,
      SSO_CLIENT_ID: clientId,
      SSO_CLIENT_SECRET: clientSecret,
      SSO_ALLOWED_DOMAINS: ssoDomain,
      NODE_EXTRA_CA_CERTS: certificate,
    },
    /**
     * Sign in through the instance as `email`, following the browser's redirects by hand. The
     * cookie is empty when the instance refused the person.
     */
    signIn: (instance: string, email: string) =>
      Effect.gen(function* () {
        yield* driver("choose the identity", () =>
          fetch(`${plainOrigin}/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, mode: "valid" }),
          }),
        );
        const started = yield* driver("start SSO sign-in", () =>
          fetch(`${instance}/api/auth/sign-in/social`, {
            method: "POST",
            headers: { origin: instance, "content-type": "application/json" },
            body: JSON.stringify({ provider: "sso", callbackURL: "/", errorCallbackURL: "/login" }),
          }).then((response) =>
            response.json().then((value) => ({
              cookie: cookieOf(response.headers),
              url: Schema.decodeUnknownSync(StartedSignIn)(value).url,
            })),
          ),
        );
        if (started.url === undefined) return { cookie: "", location: undefined };
        // The provider's address as the instance knows it; the plain listener serves the same routes.
        const authorize = started.url.replace(origin, plainOrigin);
        const returned = yield* driver("authenticate at the identity provider", () =>
          fetch(authorize, { redirect: "manual" }).then(
            (response) => response.headers.get("location") ?? undefined,
          ),
        );
        if (returned === undefined) return { cookie: "", location: undefined };
        return yield* driver("finish SSO sign-in", () =>
          fetch(returned, { redirect: "manual", headers: { cookie: started.cookie } }).then(
            (response) => ({
              cookie: cookieOf(response.headers),
              location: response.headers.get("location") ?? undefined,
            }),
          ),
        );
      }),
  };
});
