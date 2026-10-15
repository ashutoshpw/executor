/**
 * Serving one stored file over HTTP: validators, conditional requests and single byte ranges. The
 * file's ETag names its exact bytes, so a conditional request needs no read, and a range is read
 * from the store without touching the rest of the file. App assets and user-content files share
 * this one implementation.
 */
import { Effect, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

/** A file as the host stores it, readable by byte window. */
export interface RangedFile<E> {
  readonly size: number;
  /** The quoted entity tag of the file's exact bytes. */
  readonly etag: string;
  readonly contentType: string;
  /** The whole file when `range` is absent, else exactly `length` bytes from `offset`. */
  readonly read: (
    range: { readonly offset: number; readonly length: number } | undefined,
  ) => Effect.Effect<Stream.Stream<Uint8Array, unknown>, E>;
}

/**
 * Answers up to this many bytes are read into memory and sent with a fixed `Content-Length`.
 * Bun's HTTP server frames any streamed body as chunked and drops a declared length, so a
 * client could not size the download or tell a truncated one. A byte array keeps the header. A
 * larger answer streams, so memory stays bounded, and is chunked on Bun hosts.
 */
export const bufferedAnswerLimit = 4 * 1024 * 1024;

/** Whether an `If-None-Match` value names `etag`, weakly as RFC 9110 compares it. */
export const etagMatches = (header: string | undefined, etag: string) =>
  header
    ?.split(",")
    .some(
      (candidate) =>
        candidate.trim() === "*" ||
        candidate.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""),
    ) === true;

/**
 * The single byte range a request asks for, as RFC 9110 reads `Range`: `undefined` serves the
 * whole file, including for ranges this host does not support, such as several at once.
 */
export const requestedRange = (
  header: string | undefined,
  ifRange: string | undefined,
  etag: string,
  size: number,
) => {
  if (header === undefined || (ifRange !== undefined && ifRange.trim() !== etag)) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) return undefined;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return undefined;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return "unsatisfiable" as const;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (start >= size) return "unsatisfiable" as const;
  if (end < start) return undefined;
  return { start, end };
};

/**
 * Answer the current request for `file`: 304 when `If-None-Match` names its bytes, 416 for a range
 * past the end, 206 for one range and 200 otherwise. `headers` are added to every answer, so each
 * caller states its own caching and framing policy. A `HEAD` request gets the headers a `GET`
 * would, without reading a byte.
 */
export const serveRangedFile = <E>(
  file: RangedFile<E>,
  headers: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const common = { ...headers, etag: file.etag, "accept-ranges": "bytes" };
    if (etagMatches(request.headers["if-none-match"], file.etag))
      return HttpServerResponse.empty({ status: 304, headers: common });
    const range = requestedRange(
      request.headers.range,
      request.headers["if-range"],
      file.etag,
      file.size,
    );
    if (range === "unsatisfiable")
      return HttpServerResponse.empty({
        status: 416,
        headers: { ...common, "content-range": `bytes */${file.size}` },
      });
    const length = range === undefined ? file.size : range.end - range.start + 1;
    const status = range === undefined ? 200 : 206;
    const answer =
      range === undefined
        ? common
        : { ...common, "content-range": `bytes ${range.start}-${range.end}/${file.size}` };
    if (request.method === "HEAD")
      return HttpServerResponse.empty({
        status,
        headers: { ...answer, "content-type": file.contentType, "content-length": String(length) },
      });
    const body = yield* file.read(
      range === undefined ? undefined : { offset: range.start, length },
    );
    if (length <= bufferedAnswerLimit) {
      const bytes = new Uint8Array(length);
      let filled = 0;
      yield* Stream.runForEach(body, (chunk) =>
        Effect.sync(() => {
          const room = Math.min(chunk.byteLength, length - filled);
          bytes.set(room === chunk.byteLength ? chunk : chunk.subarray(0, room), filled);
          filled += room;
        }),
      ).pipe(Effect.orDie);
      if (filled !== length)
        return yield* Effect.die(`A stored file read ${filled} bytes where ${length} were stored`);
      return HttpServerResponse.uint8Array(bytes, {
        status,
        contentType: file.contentType,
        headers: answer,
      });
    }
    return HttpServerResponse.stream(body, {
      status,
      contentType: file.contentType,
      contentLength: length,
      headers: answer,
    });
  });
