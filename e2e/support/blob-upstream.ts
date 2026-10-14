/**
 * A loopback file server for the file-handle scenarios. It serves deterministic pseudo-random
 * files, so a scenario can compare any byte range an app reads back with the bytes the server
 * generated, and records each request, so a scenario can tell how often and with which headers an
 * app's host-side fetch arrived.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

/** `length` bytes of a repeatable stream for `seed` (xorshift32), the same on every call. */
export const generatedBytes = (seed: number, length: number) => {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0 || 1;
  for (let at = 0; at < length; at += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[at] = state & 0xff;
  }
  return bytes;
};
export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const chunk = 64 * 1024;

/** The files the server serves, by name. */
export const files = {
  large: { seed: 7, bytes: generatedBytes(7, 5 * 1024 * 1024) },
  small: { seed: 11, bytes: generatedBytes(11, 300 * 1024) },
  other: { seed: 13, bytes: generatedBytes(13, 64 * 1024) },
} as const;
export type FileName = keyof typeof files;

/** One request as the server received it. */
export interface Received {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Start the server on 127.0.0.1 and close it with the case scope. */
export const blobUpstream = Effect.gen(function* () {
  const received: Received[] = [];
  const routes = HttpRouter.add(
    "GET",
    "/*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://upstream");
      received.push({ path: url.pathname, headers: { ...request.headers } });
      const [, kind, name] = url.pathname.split("/");
      const file = name === undefined ? undefined : files[name as FileName];
      if (kind === "blob" && file !== undefined)
        return HttpServerResponse.uint8Array(file.bytes, {
          contentType: "application/x-fixture",
        });
      // The same bytes without a Content-Length: the body is chunked.
      if (kind === "chunked" && file !== undefined)
        return HttpServerResponse.stream(
          Stream.fromIterable(
            Array.from({ length: Math.ceil(file.bytes.length / chunk) }, (_, index) =>
              file.bytes.slice(index * chunk, (index + 1) * chunk),
            ),
          ),
          { contentType: "application/x-fixture" },
        );
      if (kind === "redirect" && file !== undefined)
        return HttpServerResponse.empty({
          status: 302,
          headers: { location: `/blob/${name}` },
        });
      if (kind === "status") return HttpServerResponse.empty({ status: Number(name) });
      return HttpServerResponse.empty({ status: 404 });
    }),
  );
  const listener = yield* Effect.sync(() => createServer());
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => listener, { host: "127.0.0.1", port: 0 })),
    ),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => listener.closeAllConnections()));
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address))
    return yield* Effect.die("The blob upstream needs a TCP listener");
  const origin = `http://127.0.0.1:${server.address.port}`;
  return {
    origin,
    url: (kind: "blob" | "chunked" | "redirect", name: FileName) => `${origin}/${kind}/${name}`,
    status: (code: number) => `${origin}/status/${code}`,
    received: Effect.sync(() => [...received]),
    /** How many requests reached `path`. */
    count: (path: string) =>
      Effect.sync(() => received.filter((entry) => entry.path === path).length),
  };
});
