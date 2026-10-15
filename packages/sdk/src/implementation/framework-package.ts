/** A built `apps` package read from disk as the files an npm archive of it would hold. */
import { Effect, FileSystem, Option, Path, Schema } from "effect";

/** The package directory is missing, incomplete or unreadable. */
export class FrameworkPackageUnavailable extends Schema.TaggedError<FrameworkPackageUnavailable>()(
  "FrameworkPackageUnavailable",
  { directory: Schema.String, reason: Schema.String },
) {}

const PackageManifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.Literal("apps"),
    version: Schema.NonEmptyString,
    files: Schema.Array(Schema.NonEmptyString),
  }),
);

/** The package's own version and its files, by package-relative path with `/` separators. */
export interface FrameworkPackage {
  readonly version: string;
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Read the staged package `bun run apps:build` writes to `packages/apps/dist`. Like `npm pack`,
 * it holds `package.json` and what the manifest's `files` lists, so a build's source maps and
 * other leftovers are not served as framework files.
 */
export const readFrameworkPackage = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifestText = yield* fs.readFileString(path.join(directory, "package.json"));
    const manifest = yield* Schema.decodeUnknownEffect(PackageManifest)(manifestText);
    const files: Record<string, string> = { "package.json": manifestText };
    const read = (relative: string) =>
      fs.readFileString(path.join(directory, relative)).pipe(
        Effect.map((content) => {
          files[relative.split(path.sep).join("/")] = content;
        }),
      );
    const add = (relative: string) =>
      Effect.gen(function* () {
        if ((yield* fs.stat(path.join(directory, relative))).type === "File")
          return yield* read(relative);
        for (const entry of yield* fs.readDirectory(path.join(directory, relative), {
          recursive: true,
        })) {
          const child = path.join(relative, entry);
          if ((yield* fs.stat(path.join(directory, child))).type === "File") yield* read(child);
        }
      });
    for (const entry of manifest.files) yield* add(path.normalize(entry));
    return { version: manifest.version, files } satisfies FrameworkPackage;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new FrameworkPackageUnavailable({
          directory,
          reason: cause.message,
        }),
    ),
  );

/**
 * The `packages/apps/dist` of the checkout that holds `from`, found by walking up to the nearest
 * directory with `packages/apps/package.json`. The same call works from a source file and from a
 * bundle in a package's `dist/`, which sit at different depths. None when `from` is not inside a
 * checkout, as in a packaged install.
 */
export const checkoutFrameworkDirectory = (from: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let directory = path.resolve(from);
    for (;;) {
      if (yield* fs.exists(path.join(directory, "packages", "apps", "package.json"))) {
        return Option.some(path.join(directory, "packages", "apps", "dist"));
      }
      const parent = path.dirname(directory);
      if (parent === directory) return Option.none<string>();
      directory = parent;
    }
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));
