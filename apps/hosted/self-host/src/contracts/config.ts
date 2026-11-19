/** Self-host storage configuration shared by the database, retained builds and diagnostics. */
import { AppUiBaseUrl } from "@executor-js/hosted-server/app-ui/contracts";
import { publishingDomain as defaultPublishingDomain } from "@executor-js/hosted-server/organization";
import { Config, Effect, Option, Schema } from "effect";

/** One persistent root; Docker supplies /app/data and source development uses .local/hosted. */
export const dataDirectory = Config.NonEmptyString("EXECUTOR_DATA_DIR").pipe(
  Config.withDefault(".local/hosted"),
);

/** Localhost works without DNS setup; production operators explicitly supply their app DNS base. */
export const appUiBaseUrl = (dashboardOrigin: string) =>
  Effect.gen(function* () {
    const configured = yield* Config.String("EXECUTOR_APP_UI_BASE_URL").pipe(Config.option);
    if (Option.isSome(configured))
      return yield* Schema.decodeUnknownEffect(AppUiBaseUrl)(configured.value);
    const dashboard = new URL(dashboardOrigin);
    if (dashboard.hostname !== "localhost" && dashboard.hostname !== "127.0.0.1") return undefined;
    dashboard.hostname = "localhost";
    return yield* Schema.decodeUnknownEffect(AppUiBaseUrl)(dashboard.origin);
  });

/**
 * App isolates reach only public addresses, the same as Executor Cloud. Requests for the
 * dashboard origin reach the product without the network, so the bundled Executor app does not
 * need this. Operators opt in to let app code reach other private destinations.
 */
export const allowPrivateAppFetch = Config.Boolean("EXECUTOR_APPS_ALLOW_PRIVATE_FETCH").pipe(
  Config.withDefault(false),
);

/** A registry mirror for app builds. Apps resolve their declared packages from the public npm registry by default. */
export const npmRegistry = Config.String("EXECUTOR_NPM_REGISTRY").pipe(Config.option);

/**
 * A built `apps` package (`bun run apps:build` writes one to `packages/apps/dist`) whose files the
 * host serves to apps that declare its exact version. Defaults to this checkout's own build. A
 * directory named here that is not a built package stops the host, because the operator asked for it.
 */
export const appsFrameworkDirectory = Config.String("EXECUTOR_APPS_FRAMEWORK_DIR").pipe(
  Config.option,
);

/** Install every `apps` release from the npm registry, including the version this host ships. */
export const appsFrameworkDisabled = Config.Boolean("EXECUTOR_APPS_FRAMEWORK_DISABLED").pipe(
  Config.withDefault(false),
);

const publishingDomainProblem =
  "EXECUTOR_PUBLISHING_DOMAIN must be a lowercase domain name such as executor.community: letters, digits, dots and hyphens, up to 70 characters, with no label starting or ending in a hyphen and no leading or trailing dot.";

/** The domain after the organization slug in public package names, `@<slug>.<domain>/<app>`. */
export const PublishingDomainSetting = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (value.length <= 70 &&
        /^[a-z0-9]+(?:-+[a-z0-9]+)*(?:\.[a-z0-9]+(?:-+[a-z0-9]+)*)*$/u.test(value)) ||
      publishingDomainProblem,
  ),
);

/**
 * Where this server's organizations publish. The default matches Executor Cloud, whose names this
 * server's catalog can sit beside; a different one keeps this server's names from looking like
 * Cloud's. A value that cannot be a domain stops the host rather than naming every package wrongly.
 */
export const publishingDomain = Effect.gen(function* () {
  const value = yield* Config.String("EXECUTOR_PUBLISHING_DOMAIN").pipe(
    Config.withDefault(defaultPublishingDomain),
  );
  return yield* Schema.decodeUnknownEffect(PublishingDomainSetting)(value);
});

/** An operator setting the server cannot start with. The message names the setting, never its value. */
export class SelfHostSettingInvalid extends Schema.TaggedError<SelfHostSettingInvalid>()(
  "SelfHostSettingInvalid",
  { message: Schema.String },
) {}

/** A whole number of at least 1, when set; otherwise `fallback`. */
const clientCount = (name: string, fallback: number) =>
  Effect.flatMap(Config.String(name).pipe(Config.option), (value) =>
    Option.isNone(value)
      ? Effect.succeed(fallback)
      : /^[1-9][0-9]*$/.test(value.value.trim())
        ? Effect.succeed(Number(value.value.trim()))
        : Effect.fail(
            new SelfHostSettingInvalid({
              message: `${name} must be a whole number of at least 1.`,
            }),
          ),
  );

/**
 * The MCP clients the server keeps protocol state for, one per API key or OAuth grant a member uses
 * (`mcpSessionKey`), and how many of them one member may hold. Past either, the least recently used
 * client without a request in flight or a paused program is forgotten, and its next request must
 * initialize again. Read at startup, so a count that is not a whole number of at least 1 stops the
 * server with an error naming the setting.
 */
export interface McpClientLimits {
  readonly total: number;
  readonly perUser: number;
}
/**
 * Measured in the image's product isolate: a client that has initialized holds about 170 to 240 KB
 * of heap, so 512 hold about 120 MB. Tool calls stayed under about 70 ms with up to about 660
 * clients kept and took 250 to 550 ms with 800. A member may hold half the list.
 */
export const defaultMcpClientLimits: McpClientLimits = { total: 512, perUser: 256 };
export const mcpClientLimits = Effect.gen(function* () {
  const limits: McpClientLimits = {
    total: yield* clientCount("EXECUTOR_MCP_CLIENTS", defaultMcpClientLimits.total),
    perUser: yield* clientCount("EXECUTOR_MCP_CLIENTS_PER_USER", defaultMcpClientLimits.perUser),
  };
  return limits;
});
