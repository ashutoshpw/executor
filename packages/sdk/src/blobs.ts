/** Binary storage contracts and an explicit ephemeral adapter. */
export * from "./contracts/blobs.ts";
export { memoryBlobStore } from "./implementation/memory-blobs.ts";
/** Streaming helpers for host blob adapters. */
export {
  bufferedBody,
  collectBytes,
  pageOf,
  rangeWindow,
  windowed,
} from "./implementation/blob-streams.ts";
/** User-content file handles: the product-owned metadata, limits and lifetime beside the store. */
export * from "./contracts/file-handles.ts";
export { makeFileHandleStore } from "./implementation/file-handles.ts";
export { fileHandleSweepLoop, sweepFileHandles } from "./implementation/file-handle-sweep.ts";
