/** The `apps` framework the native host serves from its own checkout. */
import { readFrameworkPackage } from "@executor-js/sdk/node/workerd";
import { Effect, Option, Path } from "effect";
import { appsFrameworkDirectory, appsFrameworkDisabled } from "../contracts/config.ts";

/**
 * Apps that declare the version in `packages/apps/package.json` build from these files, which speak
 * the host protocols this checkout implements. Without them such an app would install that version
 * from npm, which holds another build of it or none. A missing default build only warns and leaves
 * every release to npm; a directory the operator names must be a built package.
 */
export const selfHostAppsFramework = Effect.gen(function* () {
  if (yield* appsFrameworkDisabled) {
    yield* Effect.logInfo(
      "EXECUTOR_APPS_FRAMEWORK_DISABLED is set: every apps release installs from the npm registry.",
    );
    return undefined;
  }
  const path = yield* Path.Path;
  const configured = yield* appsFrameworkDirectory;
  const framework = readFrameworkPackage(
    Option.getOrElse(configured, () =>
      path.resolve(import.meta.dirname, "../../../../../packages/apps/dist"),
    ),
  );
  if (Option.isSome(configured)) return yield* framework;
  return yield* framework.pipe(
    Effect.catchTag("FrameworkPackageUnavailable", (error) =>
      Effect.logWarning(
        `This checkout's apps framework is not built (${error.directory}: ${error.reason}). Run bun run apps:build, or set EXECUTOR_APPS_FRAMEWORK_DIR. Until then every apps release installs from the npm registry, so apps cannot use this host's own framework version.`,
      ).pipe(Effect.as(undefined)),
    ),
  );
});
