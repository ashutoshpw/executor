/** SHA-256 over a stream of chunks in workerd, which supplies a streaming digest on `crypto`. */
import { Hex } from "effect/encoding";
import type { StreamingSha256 } from "../contracts/file-handles.ts";

interface DigestStreamConstructor {
  new (algorithm: string): WritableStream<Uint8Array> & { readonly digest: Promise<ArrayBuffer> };
}

/** A new streaming digest backed by workerd's `DigestStream`; only workerd runtimes have one. */
export const digestStreamSha256 = (): StreamingSha256 => {
  // SAFETY: `DigestStream` is a workerd extension of the global `crypto`, absent from DOM typings.
  const { DigestStream } = crypto as unknown as { DigestStream: DigestStreamConstructor };
  const stream = new DigestStream("SHA-256");
  const writer = stream.getWriter();
  return {
    write: (chunk) => writer.write(chunk),
    finish: async () => {
      await writer.close();
      return Hex.encode(new Uint8Array(await stream.digest));
    },
  };
};
