/** Host bindings exist only on the trusted product Worker, never on authored app isolates. */
import { Effect, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpServerResponse } from "effect/http";
import { dashboardRoutes, fileHeaders } from "../web.ts";
import {
  BlobKey,
  BlobStoreError,
  SourceError,
  type BlobBody,
  type BlobStorage,
} from "@executor-js/sdk/core";
import { collectBytes, pageOf, rangeWindow, windowed } from "@executor-js/sdk/blobs";
import { gitRepositories } from "@executor-js/app-source/host";
import {
  parseDestination,
  isLoopbackHostname,
  type UrlPolicy,
} from "@executor-js/utils/url-policy";

/** The HTTP service capability workerd supplies at its environment boundary. */
export interface HttpBinding {
  readonly fetch: (request: Request) => Promise<Response>;
}
/** workerd's global: a byte stream that fails unless exactly `length` bytes pass through. */
declare const FixedLengthStream: new (length: number) => TransformStream<Uint8Array, Uint8Array>;

const diskRequest = (key: BlobKey, init?: RequestInit) =>
  new Request(`http://disk.internal/${key.split("/").map(encodeURIComponent).join("/")}`, init);

/** workerd's disk service answers a directory GET with its entries as JSON. */
const DirectoryListing = Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String }));

/** workerd disk PUT atomically publishes an object; missing files remain ordinary results. */
export const bindingBlobStore = (disk: HttpBinding): BlobStorage => {
  /** A failed request keeps its cause; an answer outside `expected` keeps its status. */
  const send = (
    operation: BlobStoreError["operation"],
    key: BlobKey,
    expected: ReadonlyArray<number>,
    init?: RequestInit,
  ) =>
    Effect.tryPromise({
      try: () => {
        Schema.decodeUnknownSync(BlobKey)(key);
        return disk.fetch(diskRequest(key, init));
      },
      catch: (cause) => new BlobStoreError({ operation, cause }),
    }).pipe(
      Effect.filterOrFail(
        (response) => expected.includes(response.status),
        (response) => new BlobStoreError({ operation, status: response.status }),
      ),
    );
  return {
    get: (key) =>
      send("get", key, [200, 404]).pipe(
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeedNone
            : Effect.tryPromise({
                try: () => response.arrayBuffer(),
                catch: (cause) => new BlobStoreError({ operation: "get", cause }),
              }).pipe(Effect.map((bytes) => Option.some(new Uint8Array(bytes)))),
        ),
      ),
    exists: (key) =>
      send("exists", key, [200, 404], { method: "HEAD" }).pipe(
        Effect.map((response) => response.status === 200),
      ),
    put: (key, body) =>
      send("put", key, [204], { method: "PUT", body: new Uint8Array(body) }).pipe(Effect.asVoid),
    // With a declared size the request body streams to the disk service, through a stream that
    // fails unless exactly `size` bytes pass. workerd publishes the file only after the body
    // ends, and an errored or short body aborts the request, so nothing truncated is committed
    // and the source's own error is the one reported. Without a size workerd would commit
    // whatever arrived before a source failed, so that case buffers the object here first.
    putStream: <E>(
      key: BlobKey,
      body: Stream.Stream<Uint8Array, E>,
      options?: { readonly size?: number },
    ): Effect.Effect<void, BlobStoreError | E> => {
      const size = options?.size;
      if (size === undefined)
        return collectBytes(body, undefined).pipe(
          Effect.flatMap((bytes) =>
            send("put", key, [204], { method: "PUT", body: new Uint8Array(bytes) }),
          ),
          Effect.asVoid,
        );
      let sourceFailure: { readonly error: E } | undefined;
      const readable = Stream.toReadableStream(
        body.pipe(
          Stream.tapError((error) =>
            Effect.sync(() => {
              sourceFailure = { error };
            }),
          ),
        ),
      ).pipeThrough(new FixedLengthStream(size));
      return send("put", key, [204], {
        method: "PUT",
        body: readable,
        duplex: "half",
      } as RequestInit).pipe(
        Effect.asVoid,
        Effect.catch((error: BlobStoreError): Effect.Effect<never, BlobStoreError | E> =>
          Effect.fail(sourceFailure === undefined ? error : sourceFailure.error),
        ),
      );
    },
    remove: (key) => send("remove", key, [204, 404], { method: "DELETE" }).pipe(Effect.asVoid),
    list: (folder, options) =>
      send("list", folder, [200, 404]).pipe(
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeed([])
            : Effect.tryPromise(() => response.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(DirectoryListing)),
                Effect.mapError((cause) => new BlobStoreError({ operation: "list", cause })),
              ),
        ),
        Effect.map((entries) =>
          pageOf(
            entries.filter((entry) => entry.type === "file").map((entry) => entry.name),
            options,
          ),
        ),
      ),
    // A range goes to the disk service as a Range request. A 200 answer means it sent the whole
    // file, so the range is cut from the stream here instead.
    stream: (key, range) =>
      Effect.gen(function* () {
        const size = (response: Response) => Number(response.headers.get("content-length"));
        const head = (): Effect.Effect<Option.Option<BlobBody>, BlobStoreError> =>
          send("get", key, [200, 404], { method: "HEAD" }).pipe(
            Effect.flatMap((response) =>
              response.status === 404
                ? Effect.succeed(Option.none())
                : Number.isSafeInteger(size(response))
                  ? Effect.succeed(Option.some({ size: size(response), body: Stream.empty }))
                  : Effect.fail(new BlobStoreError({ operation: "get" })),
            ),
          );
        if (range !== undefined && range.length === 0) return yield* head();
        const response = yield* send(
          "get",
          key,
          [200, 206, 404, 416],
          range === undefined
            ? undefined
            : { headers: { range: `bytes=${range.offset}-${range.offset + range.length - 1}` } },
        );
        if (response.status === 404) return Option.none();
        // Past the end of the object: the answer carries no size we trust, so ask for it.
        if (response.status === 416) return yield* head();
        const readable = response.body;
        if (readable === null) return yield* new BlobStoreError({ operation: "get" });
        const body = Stream.fromReadableStream({
          evaluate: () => readable,
          onError: (cause) => new BlobStoreError({ operation: "get", cause }),
        });
        if (response.status === 206) {
          const total = Number(/\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1]);
          if (!Number.isSafeInteger(total)) return yield* new BlobStoreError({ operation: "get" });
          return Option.some({ size: total, body });
        }
        const whole = size(response);
        if (!Number.isSafeInteger(whole)) return yield* new BlobStoreError({ operation: "get" });
        const { start, end } = rangeWindow(whole, range);
        return Option.some({
          size: whole,
          body: start === 0 && end === whole ? body : windowed(body, start, end),
        });
      }),
  };
};

const GitResult = Schema.Struct({ code: Schema.Int, output: Schema.Uint8ArrayFromBase64 });
const Index = Schema.Struct({ index: Schema.NonEmptyString });

/** Preserve the shared Git operations while a small native helper owns processes and indexes. */
export const bindingRepositories = (binding: HttpBinding, directory: string) => {
  const call = (path: string, body: unknown) =>
    Effect.tryPromise({
      try: async () => {
        const response = await binding.fetch(
          new Request(`http://native.internal${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
        if (!response.ok) throw new Error("Native Git request failed");
        return response.json();
      },
      catch: () => new SourceError({ reason: "git" }),
    });
  return gitRepositories({
    directory,
    git: (args, input, environment) =>
      Schema.encodeEffect(Schema.Uint8ArrayFromBase64)(input ?? new Uint8Array()).pipe(
        Effect.flatMap((input) => call("/git", { args, input, environment: environment ?? {} })),
        Effect.flatMap(Schema.decodeUnknownEffect(GitResult)),
        Effect.mapError(() => new SourceError({ reason: "git" })),
      ),
    // The native helper streams the request into `git http-backend` and its output back.
    httpBackend: (environment, body) =>
      Effect.tryPromise({
        try: async () => {
          const response = await binding.fetch(
            new Request("http://native.internal/git/http-backend", {
              method: "POST",
              headers: { "executor-git-environment": JSON.stringify(environment) },
              body,
            }),
          );
          if (!response.ok || response.body === null) throw new Error("Native Git request failed");
          return response.body;
        },
        catch: () => new SourceError({ reason: "git" }),
      }),
    createDirectory: (path) => call("/git/directory", { path }).pipe(Effect.asVoid),
    temporaryIndex: Effect.acquireRelease(
      call("/git/index", {}).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Index)),
        Effect.mapError(() => new SourceError({ reason: "git" })),
      ),
      ({ index }) => call("/git/index/remove", { index }).pipe(Effect.orDie),
    ).pipe(Effect.map(({ index }) => index)),
  });
};

/**
 * DNS restrictions are enforced by workerd's network service at connection time. Requests for
 * this instance's own dashboard origin go to the product through a service binding instead,
 * whatever that origin's name resolves to.
 */
export const bindingHttpClient = (
  policy: UrlPolicy,
  publicNetwork: HttpBinding,
  privateNetwork: HttpBinding,
  self: { readonly origin: string; readonly binding: HttpBinding },
) =>
  Effect.gen(function* () {
    const selfOrigin = new URL(self.origin).origin;
    const checkedFetch: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (URL.parse(url)?.origin === selfOrigin)
        return self.binding.fetch(new Request(input, { ...init, redirect: "manual" }));
      const destination = parseDestination(url, policy);
      if (destination === undefined) throw new Error("Requested destination refused");
      const network =
        (policy.allowLoopbackHttp && isLoopbackHostname(destination.hostname)) ||
        policy.allowedHttpOrigins.some((origin) => origin === destination.origin)
          ? privateNetwork
          : publicNetwork;
      return network.fetch(new Request(input, { ...init, redirect: "manual" }));
    };
    const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
    return client.pipe(
      HttpClient.transformResponse(Effect.provideService(FetchHttpClient.Fetch, checkedFetch)),
    );
  });

/** The bundled collector's internal origin; it names a service binding, never a network address. */
export const collectorOrigin = "http://motel.internal";

/**
 * Telemetry exports to the bundled collector go through its service binding, which the host
 * connects to a private Unix socket. The collector has no TCP listener, so an app's fetch cannot
 * reach it even when private fetch is allowed. Exports to any other collector use the network.
 */
export const bindingTelemetryClient = (collector: HttpBinding) =>
  Effect.gen(function* () {
    const routedFetch: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      return URL.parse(request.url)?.origin === collectorOrigin
        ? collector.fetch(request)
        : fetch(request);
    };
    const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
    return client.pipe(
      HttpClient.transformResponse(Effect.provideService(FetchHttpClient.Fetch, routedFetch)),
    );
  });

/** Serve only the build's asset manifest; a disk directory listing can never become a public page. */
export const bindingDashboard = (assets: HttpBinding, files: Readonly<Record<string, string>>) =>
  dashboardRoutes(new Set(Object.keys(files)), (relative) =>
    Effect.tryPromise(() =>
      assets.fetch(
        new Request(
          `http://assets.internal/${relative.split("/").map(encodeURIComponent).join("/")}`,
        ),
      ),
    ).pipe(
      Effect.map((response) =>
        HttpServerResponse.fromWeb(response).pipe(
          HttpServerResponse.setHeaders({
            "content-type": files[relative] ?? "application/octet-stream",
            ...fileHeaders(relative),
          }),
        ),
      ),
    ),
  );
