/**
 * `executor files`: move the files an organization's apps keep by handle. A handle is a reference;
 * these commands move the bytes it names, over the host's authenticated file routes. Downloads
 * resume with byte ranges and are verified against the file's own SHA-256, so an interrupted or
 * corrupted transfer is never mistaken for a complete one.
 */
import { createHash } from "node:crypto";
import { Console, Effect, FileSystem, Option, Schema, Stdio, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { PlatformError } from "effect/PlatformError";
import { FilesFailed } from "./client-error.ts";
import {
  access,
  connection,
  hostFailure,
  hostResolver,
  transport,
  type Host,
  type LocalServer,
  type WithHost,
} from "./cli.ts";

const Handle = Schema.Struct({
  id: Schema.String,
  sha256: Schema.String,
  size: Schema.Int,
  contentType: Schema.String,
  expiresAt: Schema.String,
});

/** The client and the files path of the host the command targets. */
const target = (host: Host, organization: Option.Option<string>) =>
  Effect.gen(function* () {
    const resolved = yield* access(host, organization);
    const prefix =
      resolved.organization === undefined
        ? "/api"
        : `/api/organizations/${encodeURIComponent(resolved.organization)}`;
    return { client: yield* transport(host.origin, resolved.token), files: `${prefix}/files` };
  });

/** The SHA-256 a response's ETag names, `"sha256-<hex>"`. */
const checksumOf = (etag: string | undefined) => /^"sha256-([0-9a-f]{64})"$/u.exec(etag ?? "")?.[1];

const fileSha256 = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const hash = createHash("sha256");
    yield* fs
      .stream(path)
      .pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))));
    return hash.digest("hex");
  });

/** The size of an existing file, or 0 when there is none. */
const existingSize = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(path))) return 0;
    return Number((yield* fs.stat(path)).size);
  });

const output = Flag.String("output").pipe(
  Flag.withDescription(
    "Save the file here. Without it the bytes go to stdout, which must not be a terminal",
  ),
  Flag.optional,
);

const get = <E, R>(withHost: WithHost<E, R>) =>
  Command.make("get", {
    ...connection,
    handle: Argument.String("handle").pipe(
      Argument.withDescription("The file handle id an app returned, such as from ctx.blobs"),
    ),
    output,
    resume: Flag.Boolean("resume").pipe(
      Flag.withDescription(
        "Continue a partial --output file with a byte range instead of starting again",
      ),
      Flag.withDefault(false),
    ),
  }).pipe(
    Command.withDescription(
      "Download a file's bytes and verify them against the file's SHA-256. With --output, prints the saved file as JSON {id, path, size, sha256}",
    ),
    Command.withExamples([
      {
        command: "executor files get <handle> --output report.pdf",
        description: "Save a file, verified",
      },
      {
        command: "executor files get <handle> --output big.bin --resume",
        description: "Finish an interrupted download",
      },
    ]),
    Command.withHandler((args) =>
      withHost(args.host, (host) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const stdio = yield* Stdio.Stdio;
          const { client, files } = yield* target(host, args.organization);
          const url = `${files}/${encodeURIComponent(args.handle)}`;
          if (Option.isNone(args.output)) {
            if (process.stdout.isTTY) return yield* new FilesFailed({ reason: "terminal" });
            const response = yield* client
              .execute(HttpClientRequest.get(url))
              .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
            const hash = createHash("sha256");
            yield* response.stream.pipe(
              Stream.tap((chunk) => Effect.sync(() => hash.update(chunk))),
              Stream.run(stdio.stdout({ endOnDone: false })),
            );
            const expected = checksumOf(response.headers.etag);
            if (expected !== undefined && expected !== hash.digest("hex"))
              return yield* new FilesFailed({ reason: "checksum" });
            return;
          }
          const path = args.output.value;
          // The validator of the bytes a partial file holds, kept beside it so a resume can ask the
          // host to continue only if the file is unchanged (`If-Range`).
          const validatorPath = `${path}.etag`;
          const exists = yield* fs.exists(path);
          if (exists && !args.resume) return yield* new FilesFailed({ reason: "exists" });
          // Each attempt either completes the file or learns that the partial one cannot be continued.
          const download = (
            offset: number,
          ): Effect.Effect<
            HttpClientResponse.HttpClientResponse,
            HttpClientError.HttpClientError | PlatformError,
            FileSystem.FileSystem
          > =>
            Effect.gen(function* () {
              const validator =
                offset > 0 && (yield* fs.exists(validatorPath))
                  ? (yield* fs.readFileString(validatorPath)).trim()
                  : "";
              const response = yield* client.execute(
                offset === 0
                  ? HttpClientRequest.get(url)
                  : HttpClientRequest.get(url, {
                      headers:
                        validator === ""
                          ? { range: `bytes=${offset}-` }
                          : { range: `bytes=${offset}-`, "if-range": validator },
                    }),
              );
              if (response.status === 416 && offset > 0) {
                // The partial file is as long as the file, or longer: the first means it is complete.
                const size = /^bytes \*\/(\d+)$/u.exec(
                  response.headers["content-range"] ?? "",
                )?.[1];
                if (size !== undefined && Number(size) === offset) return response;
                yield* fs.remove(path);
                yield* fs.remove(validatorPath, { force: true });
                return yield* download(0);
              }
              const ok = yield* HttpClientResponse.filterStatusOk(response);
              // A host that ignored the range, or whose file changed since the partial was started
              // (`If-Range`), answered with the whole file.
              const resumed = ok.status === 206 && offset > 0;
              const etag = ok.headers.etag;
              if (etag !== undefined) yield* fs.writeFileString(validatorPath, etag);
              yield* ok.stream.pipe(Stream.run(fs.sink(path, { flag: resumed ? "a" : "w" })));
              return ok;
            });
          const response = yield* download(exists ? yield* existingSize(path) : 0);
          const sha256 = yield* fileSha256(path);
          yield* fs.remove(validatorPath, { force: true });
          const expected = checksumOf(response.headers.etag);
          if (expected !== undefined && expected !== sha256)
            return yield* new FilesFailed({ reason: "checksum" });
          yield* Console.log(
            JSON.stringify(
              { id: args.handle, path, size: Number((yield* fs.stat(path)).size), sha256 },
              null,
              2,
            ),
          );
        }).pipe(Effect.catchIf(HttpClientError.isHttpClientError, hostFailure)),
      ),
    ),
  );

const put = <E, R>(withHost: WithHost<E, R>) =>
  Command.make("put", {
    ...connection,
    path: Argument.Path("path", { pathType: "file", mustExist: true }).pipe(
      Argument.withDescription("The file to upload"),
    ),
    contentType: Flag.String("content-type").pipe(
      Flag.withDescription("The file's content type; defaults to application/octet-stream"),
      Flag.withDefault("application/octet-stream"),
    ),
  }).pipe(
    Command.withDescription(
      "Upload a file and print its handle as JSON {id, sha256, size, contentType, expiresAt}. Uploading bytes the organization already holds returns that file's handle",
    ),
    Command.withExamples([
      {
        command: "executor files put ./report.pdf --content-type application/pdf",
        description: "Store a file and print its handle",
      },
    ]),
    Command.withHandler((args) =>
      withHost(args.host, (host) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          if ((yield* fs.stat(args.path)).type !== "File")
            return yield* new FilesFailed({ reason: "not-a-file" });
          const { client, files } = yield* target(host, args.organization);
          const request = yield* HttpClientRequest.put(files, {
            headers: { "x-executor-content-type": args.contentType },
          }).pipe(HttpClientRequest.bodyFile(args.path));
          const response = yield* client
            .execute(request)
            .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
          const handle = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Handle)),
          );
          yield* Console.log(JSON.stringify(handle, null, 2));
        }).pipe(Effect.catchIf(HttpClientError.isHttpClientError, hostFailure)),
      ),
    ),
  );

/**
 * The executable supplies one platform layer and owns process lifetime. `localServer` resolves the
 * local Executor that commands use when neither --host nor EXECUTOR_HOST names a host, as for
 * `executor apps`.
 */
export const filesCommand = <E = never, R = never>(
  localServer?: Effect.Effect<LocalServer, E, R>,
) => {
  const withHost = hostResolver(localServer);
  return Command.make("files").pipe(
    Command.withDescription(
      "Download and upload the files an organization's apps keep by handle. Output is JSON on stdout. A failure exits 1 and prints the error's message, code, HTTP status and recovery on stderr, and as JSON on stdout when stdout is not a terminal. Uses the same host and credentials as executor apps",
    ),
    Command.withSubcommands([get(withHost), put(withHost)]),
  );
};
