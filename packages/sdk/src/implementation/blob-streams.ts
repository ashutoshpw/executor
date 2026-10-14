/** Shared pieces of streamed blob reads and folder listings, for every store adapter. */
import { Effect, Stream } from "effect";
import { BlobStoreError, type BlobBody, type BlobRange } from "../contracts/blobs.ts";

/** The clamped byte window a range selects in an object of `size` bytes. */
export const rangeWindow = (size: number, range: BlobRange | undefined) => {
  const start = Math.min(range?.offset ?? 0, size);
  const end = range === undefined ? size : Math.min(start + range.length, size);
  return { start, end };
};

/** A buffered object served through the streaming contract. */
export const bufferedBody = (bytes: Uint8Array, range: BlobRange | undefined): BlobBody => {
  const { start, end } = rangeWindow(bytes.length, range);
  return { size: bytes.length, body: Stream.make(bytes.slice(start, end)) };
};

/** The bytes of a whole-object stream between `start` and `end`, for stores without range reads. */
export const windowed = <E>(stream: Stream.Stream<Uint8Array, E>, start: number, end: number) => {
  let position = 0;
  return stream.pipe(
    Stream.takeWhile(() => position < end),
    Stream.map((chunk) => {
      const from = position;
      position += chunk.byteLength;
      return chunk.subarray(
        Math.max(0, start - from),
        Math.max(0, Math.min(chunk.byteLength, end - from)),
      );
    }),
    Stream.filter((chunk) => chunk.byteLength > 0),
  );
};

/** One page of a folder whose every name is known, for stores without paged listing. */
export const pageOf = (
  names: ReadonlyArray<string>,
  options: { readonly startAfter?: string | undefined; readonly limit: number },
) => {
  const after = options.startAfter;
  const sorted = names.filter((name) => after === undefined || name > after).sort();
  return { names: sorted.slice(0, options.limit), truncated: sorted.length > options.limit };
};

/** Every byte of a stream in one array. A declared `size` that differs fails, as the contract says. */
export const collectBytes = <E>(
  body: Stream.Stream<Uint8Array, E>,
  size: number | undefined,
): Effect.Effect<Uint8Array, BlobStoreError | E> =>
  Stream.runCollect(body).pipe(
    Effect.flatMap((chunks) => {
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      return size !== undefined && bytes.length !== size
        ? Effect.fail(new BlobStoreError({ operation: "put" }))
        : Effect.succeed(bytes);
    }),
  );
