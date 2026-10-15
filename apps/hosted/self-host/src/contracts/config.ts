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

/** The official app feed's index.json that Add app lists. Without it the catalog lists only built-in apps. */
export const catalogFeedUrl = Config.String("EXECUTOR_CATALOG_URL").pipe(Config.option);

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
