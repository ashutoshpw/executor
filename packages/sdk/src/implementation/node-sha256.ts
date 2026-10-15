/** SHA-256 over a stream of chunks in Node or Bun, which hash incrementally through `node:crypto`. */
import { createHash } from "node:crypto";
import type { StreamingSha256 } from "../contracts/file-handles.ts";

/** A new streaming digest. */
export const nodeSha256 = (): StreamingSha256 => {
  const hash = createHash("sha256");
  return {
    write: async (chunk) => {
      hash.update(chunk);
    },
    finish: async () => hash.digest("hex"),
  };
};
