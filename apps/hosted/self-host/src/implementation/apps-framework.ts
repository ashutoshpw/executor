/** The `apps` framework the native host serves from its own checkout. */
import { checkoutFrameworkDirectory, readFrameworkPackage } from "@executor-js/sdk/node/workerd";
import { Effect, Option } from "effect";
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
  const configured = yield* appsFrameworkDirectory;
  if (Option.isSome(configured)) return yield* readFrameworkPackage(configured.value);
  // Found by walking up, so it holds for `bun src/main.ts` and for the bundle in `dist/` alike.
  const found = yield* checkoutFrameworkDirectory(import.meta.dirname);
  const directory = Option.getOrElse(found, () => "(no checkout)");
  return yield* readFrameworkPackage(directory).pipe(
    Effect.catchTag("FrameworkPackageUnavailable", (error) =>
      Effect.logWarning(
        `This checkout's apps framework is not built (${error.directory}: ${error.reason}). Run bun run apps:build, or set EXECUTOR_APPS_FRAMEWORK_DIR. Until then every apps release installs from the npm registry, so apps cannot use this host's own framework version.`,
      ).pipe(Effect.as(undefined)),
    ),
  );
});
