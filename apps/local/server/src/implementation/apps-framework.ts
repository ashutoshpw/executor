/** The `apps` framework a local server run from a checkout serves to apps. */
import { checkoutFrameworkDirectory, readFrameworkPackage } from "@executor-js/sdk/node/workerd";
import { Config, Effect, Option } from "effect";

/**
 * Apps that declare the version in `packages/apps/package.json` build from these files, which speak
 * the host protocols this checkout implements; npm holds another build of that version or none, and
 * every app the CLI scaffolds declares it. A server that is not inside a checkout, such as a packaged
 * install, serves none and installs every release from npm. An unbuilt checkout only warns, and a
 * directory the operator names with `EXECUTOR_APPS_FRAMEWORK_DIR` must be a built package.
 * `EXECUTOR_APPS_FRAMEWORK_DISABLED=true` installs every release from npm.
 */
export const localAppsFramework = Effect.gen(function* () {
  if (yield* Config.Boolean("EXECUTOR_APPS_FRAMEWORK_DISABLED").pipe(Config.withDefault(false))) {
    return undefined;
  }
  const configured = yield* Config.String("EXECUTOR_APPS_FRAMEWORK_DIR").pipe(Config.option);
  if (Option.isSome(configured)) return yield* readFrameworkPackage(configured.value);
  const found = yield* checkoutFrameworkDirectory(import.meta.dirname);
  if (Option.isNone(found)) return undefined;
  return yield* readFrameworkPackage(found.value).pipe(
    Effect.catchTag("FrameworkPackageUnavailable", (error) =>
      Effect.logWarning(
        `This checkout's apps framework is not built (${error.directory}: ${error.reason}). Run bun run apps:build, or set EXECUTOR_APPS_FRAMEWORK_DIR. Until then apps scaffolded here install this version from npm, which does not hold it.`,
      ).pipe(Effect.as(undefined)),
    ),
  );
});
