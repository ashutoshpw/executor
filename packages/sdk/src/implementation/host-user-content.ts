/**
 * The user-content store as the apps Worker's runner reaches it: through its `HOST` binding to the
 * product, which owns the real store. Bytes stream through; the product writes them to disk or its
 * bucket. See `userContentRequest` for the product's side.
 */
import type { Fetcher } from "@cloudflare/workers-types";
import { Effect, Option, Stream } from "effect";
import { BlobStoreError, type BlobKey, type BlobStorage } from "../contracts/blobs.ts";

/** Where the host serves user-content objects, one path per key. */
export const userContentPath = "/user-content/";
/** The exact length of an upload, when its sender knows it. */
export const sizeHeader = "x-executor-size";
/** The `offset,length` window of a download. */
export const rangeHeader = "x-executor-range";

type HostFetcher = Pick<Fetcher, "fetch">;
type HostResponse = Awaited<ReturnType<Fetcher["fetch"]>>;

export const hostUserContentStore = (host: HostFetcher): BlobStorage => {
  const url = (key: BlobKey) => `https://host.internal${userContentPath}${key}`;
  const send = (
    operation: BlobStoreError["operation"],
    key: BlobKey,
    accepted: ReadonlyArray<number>,
    init?: RequestInit,
  ) =>
    Effect.tryPromise({
      // SAFETY: the Worker's `RequestInit` and the DOM's differ only in declarations.
      try: () => host.fetch(url(key), init as never),
      catch: (cause) => new BlobStoreError({ operation, cause }),
    }).pipe(
      Effect.flatMap((response) =>
        accepted.includes(response.status)
          ? Effect.succeed(response)
          : Effect.fail(new BlobStoreError({ operation, status: response.status })),
      ),
    );
  const bytesOf = (operation: BlobStoreError["operation"], response: HostResponse) =>
    Effect.tryPromise({
      try: async () => new Uint8Array(await response.arrayBuffer()),
      catch: (cause) => new BlobStoreError({ operation, cause }),
    });
  return {
    get: (key) =>
      send("get", key, [200, 404]).pipe(
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeed(Option.none<Uint8Array>())
            : bytesOf("get", response).pipe(Effect.map(Option.some)),
        ),
      ),
    exists: (key) =>
      send("exists", key, [200, 404], { method: "HEAD" }).pipe(
        Effect.map((response) => response.status === 200),
      ),
    put: (key, body) =>
      send("put", key, [204], {
        method: "PUT",
        headers: { [sizeHeader]: String(body.byteLength) },
        body: new Uint8Array(body),
      }).pipe(Effect.asVoid),
    putStream: <E>(
      key: BlobKey,
      body: Stream.Stream<Uint8Array, E>,
      options?: { readonly size?: number },
    ) => {
      // A source failure aborts the request, which fails the host's write and publishes nothing;
      // the source's own error is the one reported.
      let sourceFailure: { readonly error: E } | undefined;
      const readable = Stream.toReadableStream(
        body.pipe(
          Stream.tapError((error) =>
            Effect.sync(() => {
              sourceFailure = { error };
            }),
          ),
        ),
      );
      return send("put", key, [204], {
        method: "PUT",
        headers: options?.size === undefined ? {} : { [sizeHeader]: String(options.size) },
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
    // The runner never lists user content; the sweep walks the product's rows instead.
    list: () => Effect.fail(new BlobStoreError({ operation: "list" })),
    stream: (key, range) =>
      send("get", key, [200, 404], {
        headers: range === undefined ? {} : { [rangeHeader]: `${range.offset},${range.length}` },
      }).pipe(
        Effect.map((response) => {
          const content = response.body;
          return response.status === 404
            ? Option.none()
            : Option.some({
                size: Number(response.headers.get(sizeHeader) ?? 0),
                body:
                  content === null
                    ? Stream.empty
                    : Stream.fromReadableStream({
                        // SAFETY: workerd's ReadableStream is the global one under another declaration.
                        evaluate: () => content as unknown as ReadableStream<Uint8Array>,
                        onError: (cause) => new BlobStoreError({ operation: "get", cause }),
                      }),
              });
        }),
      ),
  };
};
