/** Publish a chosen Git snapshot; installation creates an ordinary, independently owned app. */
import { Clock, Effect, Option, Result, Schema } from "effect";
import type { Executor } from "../contracts/executor.ts";
import {
  PackageManifest,
  PackageName,
  Publication,
  PublicationIssue,
  PublicationReadiness,
  PublicationSnapshot,
  RegistryError,
  packageLabel,
  packageScope,
  publicPackageName,
  type PublicationReference,
  type Registry,
  type RegistryOptions,
  type RegistryStorage,
  type StoredPublication,
} from "../contracts/registry.ts";
import { JsonObject } from "../contracts/shared.ts";
import {
  SourceFiles,
  isPublicSourcePath,
  sourceFileBytes,
  sourceText,
  type AppSourceStorage,
} from "../contracts/source.ts";
import type { AppCopySnapshot } from "../contracts/apps.ts";
import type { Query } from "./database.ts";
import { storedApp } from "./apps.ts";
import { initializeAppRepository } from "./initial-source.ts";
import type { BlobStorage } from "../contracts/blobs.ts";

const invalid = (reason: typeof PublicationIssue.Type.reason, name: string | null = null) =>
  new PublicationIssue({ reason, name });

/** Parse the exact saved source that will be published without evaluating any app code. */
const publicationSource = (files: SourceFiles) =>
  Effect.gen(function* () {
    // Public files under ui/public/ are bounded by the source's own public limits; a listing
    // reads them only when it is installed.
    const code = files.filter((file) => !isPublicSourcePath(file.path));
    if (
      code.length > 512 ||
      code.reduce((size, file) => size + sourceFileBytes(file), 0) > 4 * 1024 * 1024
    )
      return yield* invalid("limit");
    if (
      files.some((file) =>
        /(^|\/)(?:\.git|node_modules|\.env(?:\..*)?|\.npmrc|\.executor)(?:\/|$)/.test(file.path),
      )
    )
      return yield* invalid("invalid-source");
    const content = sourceText(files, "package.json");
    if (content === undefined) return yield* invalid("missing-manifest");
    const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(
      content,
    ).pipe(Effect.mapError(() => invalid("invalid-json")));
    const name = document.name;
    if (name === undefined || name === "") return yield* invalid("missing-name");
    if (typeof name !== "string") return yield* invalid("invalid-name");
    if (!Schema.is(PackageName)(name))
      return yield* invalid(
        /^[a-z0-9][a-z0-9-]{0,62}$/.test(name) ? "unscoped-name" : "invalid-name",
        name,
      );
    return yield* Schema.decodeUnknownEffect(PackageManifest)(document).pipe(
      Effect.mapError(() => invalid("invalid-metadata", name)),
    );
  });

/** Keep the established write error contract while previews expose the precise repair. */
const publicationFailure = (issue: PublicationIssue): RegistryError => {
  switch (issue.reason) {
    case "forbidden-scope":
      return new RegistryError({ reason: "forbidden" });
    case "name-taken":
      return new RegistryError({ reason: "conflict" });
    case "limit":
    case "invalid-source":
      return new RegistryError({ reason: issue.reason });
    case "missing-manifest":
    case "invalid-json":
    case "missing-name":
    case "unscoped-name":
    case "invalid-name":
    case "invalid-metadata":
      return new RegistryError({ reason: "invalid-manifest" });
  }
};

/** A catalog entry reads its pinned Git snapshot, independent of the editable default branch. */
const storedRegistry = (
  storage: RegistryStorage,
  sources: AppSourceStorage,
  origin: string,
): Registry => {
  /** The listing's retained source, only while it still selects this commit. */
  const selected = (name: string, commit: string) =>
    Effect.gen(function* () {
      const row = yield* storage.get(name);
      if (row.publication.commit !== commit) return yield* new RegistryError({ reason: "changed" });
      return row;
    });
  // The retained snapshot's tree is the published commit's, so a path names only its files.
  const read = (source: StoredPublication["source"]) => (path: string) =>
    sources
      .file(source, path)
      .pipe(
        Effect.mapError((error) =>
          error.reason === "not-found"
            ? new RegistryError({ reason: "not-found" })
            : new RegistryError({ reason: "storage" }),
        ),
      );
  return {
    origin,
    list: storage.list,
    snapshot: (name, commit) =>
      Effect.gen(function* () {
        const row = yield* selected(name, commit);
        const files = yield* sources
          .read(row.source)
          .pipe(Effect.mapError(() => new RegistryError({ reason: "storage" })));
        return PublicationSnapshot.make({ publication: row.publication, files });
      }),
    file: (name, commit, path) =>
      selected(name, commit).pipe(Effect.flatMap((row) => read(row.source)(path))),
    files: (name, commit) => selected(name, commit).pipe(Effect.map((row) => read(row.source))),
  };
};

/** Resolve reviewed public source for the shared copy operation. No app is created here. */
export const resolvePublication = (
  registry: Registry,
  input: PublicationReference,
): Effect.Effect<AppCopySnapshot, RegistryError> =>
  Effect.gen(function* () {
    const { snapshot, origin } =
      registry.resolve === undefined
        ? {
            snapshot: yield* registry.snapshot(input.package, input.commit),
            origin: registry.origin,
          }
        : yield* registry.resolve(input.package, input.commit);
    if (snapshot.publication.name !== input.package || snapshot.publication.commit !== input.commit)
      return yield* new RegistryError({ reason: "changed" });
    const manifest = yield* publicationSource(snapshot.files).pipe(
      Effect.mapError(publicationFailure),
    );
    // The source keeps the name it was published under; its owner may have changed scope since.
    if (packageLabel(manifest.name) !== packageLabel(input.package))
      return yield* new RegistryError({ reason: "invalid-source" });
    return {
      files: snapshot.files,
      origin: {
        reference: new URL(
          `/api/registry/source?name=${encodeURIComponent(input.package)}&commit=${encodeURIComponent(input.commit)}`,
          origin,
        ).href,
        name: input.package,
        commit: input.commit,
      },
      activation: "deploy",
    };
  });

const byName = (left: Publication, right: Publication) =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

/**
 * This executor's own listings first, then an upstream catalog's. A name this executor lists is
 * never shadowed by the upstream's. An upstream failure hides only the upstream's listings from the
 * full list; reading a name or its source still reports it, because the caller asked for it.
 */
const layeredRegistry = (local: Registry, upstream: Registry): Registry => {
  const missing = (error: RegistryError) => error.reason === "not-found";
  const files = (name: string, commit: string) =>
    local
      .files(name, commit)
      .pipe(
        Effect.catchTag("RegistryError", (error) =>
          missing(error) ? upstream.files(name, commit) : Effect.fail(error),
        ),
      );
  const resolve = (name: string, commit: string) =>
    local.snapshot(name, commit).pipe(
      Effect.map((snapshot) => ({ snapshot, origin: local.origin })),
      Effect.catchTag("RegistryError", (error) =>
        missing(error)
          ? upstream
              .snapshot(name, commit)
              .pipe(Effect.map((snapshot) => ({ snapshot, origin: upstream.origin })))
          : Effect.fail(error),
      ),
    );
  return {
    origin: local.origin,
    // The origin comes from the registry that answered, never from a second read.
    resolve,
    list: (name) =>
      Effect.gen(function* () {
        const own = yield* local.list(name);
        if (name !== undefined) return own.length > 0 ? own : yield* upstream.list(name);
        const others = yield* upstream.list().pipe(
          Effect.catchTag("RegistryError", (error) =>
            Effect.logWarning("The upstream app catalog could not be read", {
              reason: error.reason,
            }).pipe(Effect.as([] as ReadonlyArray<Publication>)),
          ),
        );
        const names = new Set(own.map((listing) => listing.name));
        return [...own, ...others.filter((listing) => !names.has(listing.name))].sort(byName);
      }),
    snapshot: (name, commit) => Effect.map(resolve(name, commit), ({ snapshot }) => snapshot),
    files,
    // A listing found here answers for all of its paths; a missing path is not another listing's.
    file: (name, commit, path) => files(name, commit).pipe(Effect.flatMap((read) => read(path))),
  };
};

const unsupported = () => new RegistryError({ reason: "unsupported" });

/** Catalog reads for every executor; publication writes only where the catalog is stored here. */
export const makeRegistry = (
  options: RegistryOptions,
  origin: string,
  db: Query,
  sources: AppSourceStorage,
  blobs: BlobStorage,
): {
  readonly reads: Registry;
  readonly registry: Executor["registry"];
  readonly publications: Executor["publications"];
} => {
  const stored = "storage" in options ? options.storage : undefined;
  const own: Registry =
    stored === undefined ? (options as Registry) : storedRegistry(stored, sources, origin);
  const upstream = "storage" in options ? options.upstream : undefined;
  // Public reads serve only this executor's listings; installation and the catalog that
  // publishers browse also see the upstream's.
  const reads = upstream === undefined ? own : layeredRegistry(own, upstream);
  const registry: Executor["registry"] = {
    list: (input = {}) => own.list(input.name),
    snapshot: (input) => own.snapshot(input.name, input.commit),
    file: (input) => own.file(input.name, input.commit, input.path),
  };
  const catalog: Executor["publications"]["catalog"] = (input = {}) => reads.list(input.name);
  if (stored === undefined)
    return {
      reads,
      registry,
      publications: {
        status: () => Effect.succeed({ publishing: false, origin: reads.origin }),
        catalog,
        preview: () => Effect.fail(unsupported()),
        publish: () => Effect.fail(unsupported()),
        owned: () => Effect.succeed([]),
        unpublish: () => Effect.fail(unsupported()),
      },
    };
  const storage = stored;
  const validate = (input: {
    readonly owner: Parameters<Executor["publications"]["publish"]>[0]["owner"];
    readonly namespace: string;
    readonly app: Parameters<Executor["publications"]["publish"]>[0]["app"];
    readonly files: SourceFiles;
  }) =>
    Effect.gen(function* () {
      const manifest = yield* publicationSource(input.files);
      // An owner publishes only under its current scope. Scopes are never claimed, so one the
      // owner used before is free for its next holder.
      if (packageScope(manifest.name) !== input.namespace)
        return yield* new PublicationIssue({ reason: "forbidden-scope", name: manifest.name });
      const existing = yield* storage.get(manifest.name).pipe(
        Effect.map(Option.some),
        Effect.catchTag("RegistryError", (error) =>
          error.reason === "not-found" ? Effect.succeed(Option.none()) : Effect.fail(error),
        ),
      );
      if (Option.isSome(existing) && existing.value.app !== input.app)
        return yield* new PublicationIssue({ reason: "name-taken", name: manifest.name });
      // A name the upstream lists stays the upstream's: this catalog would hide it from Add app and
      // break installs of its real commit. An app already published here keeps its listing.
      if (upstream !== undefined && Option.isNone(existing)) {
        const listed = yield* upstream.list(manifest.name).pipe(
          Effect.catchTag("RegistryError", (error) =>
            Effect.logWarning("The upstream app catalog could not be checked for this name", {
              reason: error.reason,
            }).pipe(Effect.as([] as ReadonlyArray<Publication>)),
          ),
        );
        if (listed.length > 0)
          return yield* new PublicationIssue({ reason: "name-taken", name: manifest.name });
      }
      return manifest;
    });
  return {
    reads,
    registry,
    publications: {
      status: () => Effect.succeed({ publishing: true, origin: reads.origin }),
      catalog,
      preview: (input) =>
        Effect.gen(function* () {
          const app = yield* storedApp(db, input);
          const files =
            input.files ??
            (yield* Effect.gen(function* () {
              const initialized = yield* initializeAppRepository(db, sources, blobs, app);
              const workspace = Option.isSome(initialized)
                ? initialized.value
                : yield* sources.workspace(app.code);
              if (workspace === null) return yield* new RegistryError({ reason: "not-found" });
              return workspace.files;
            }));
          const checked = yield* validate({ ...input, files }).pipe(Effect.result);
          if (Result.isSuccess(checked))
            return PublicationReadiness.make({ status: "ready", manifest: checked.success });
          if (!Schema.is(PublicationIssue)(checked.failure))
            return yield* Effect.fail(checked.failure);
          // A name under another scope keeps its label in the current one.
          const initial = publicPackageName(
            input.namespace,
            checked.failure.reason === "forbidden-scope" && checked.failure.name !== null
              ? checked.failure.name
              : app.name,
          );
          const suggested =
            checked.failure.reason === "name-taken" &&
            Option.isSome(initial) &&
            initial.value === checked.failure.name
              ? publicPackageName(input.namespace, `${app.name} copy`)
              : initial;
          return PublicationReadiness.make({
            status: "blocked",
            issue: checked.failure,
            suggestedName: Option.getOrNull(suggested),
          });
        }).pipe(Effect.withSpan("sdk.publications.preview")),
      publish: (input) =>
        Effect.gen(function* () {
          const app = yield* storedApp(db, input);
          const files = yield* sources
            .read({ code: app.code, commit: input.commit })
            .pipe(Effect.mapError(() => new RegistryError({ reason: "invalid-source" })));
          const manifest = yield* validate({ ...input, files }).pipe(
            Effect.catchTag("PublicationIssue", (issue) => Effect.fail(publicationFailure(issue))),
          );
          const source = yield* sources
            .retain(app.code, files, input.commit)
            .pipe(Effect.mapError(() => new RegistryError({ reason: "storage" })));
          return yield* storage.publish({
            name: manifest.name,
            owner: input.owner,
            app: app.id,
            source,
            publication: Publication.make({
              name: manifest.name,
              commit: input.commit,
              description: manifest.description ?? "",
              publishedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
            }),
          });
        }).pipe(Effect.withSpan("sdk.publications.publish")),
      owned: (input) => storage.owned(input.owner),
      unpublish: (input) =>
        storage.unpublish(input.owner, input.package).pipe(Effect.as({ name: input.package })),
    },
  };
};
