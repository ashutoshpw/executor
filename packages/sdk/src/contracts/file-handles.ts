/**
 * User-content file handles: the product-owned metadata, lifetime and limits that sit beside a
 * host's `user-content` blob store. The store holds the bytes under `<owner>/<handle id>`; this
 * module decides who may reach them, for how long, and what happens when two apps store the same
 * file. Apps see none of it: `ctx.blobs` returns handles.
 */
import { Schema, type Effect } from "effect";
import {
  BlobError,
  BlobHandle,
  type BlobLimits,
  type BlobNotFound,
  type BlobUnavailable,
} from "apps/contracts";
import type { BlobKey, BlobStorage } from "./blobs.ts";

/** What a product's store accepts and how long it keeps files. */
export interface BlobPolicy {
  readonly maxFileBytes: number;
  readonly maxInlineBytes: number;
  readonly maxReadBytes: number;
  readonly methods: BlobLimits["methods"];
  /**
   * The host's store cannot take a stream of unknown length, so `fromUrl` needs the upstream's
   * Content-Length or an `expectedSize`.
   */
  readonly requiresSize: boolean;
  /** The lifetime a new handle gets for this owner. */
  readonly ttlSeconds: (owner: string) => Effect.Effect<number>;
}

/** Defaults every product starts from. */
export const defaultBlobPolicy = {
  maxInlineBytes: 256 * 1024,
  maxReadBytes: 1024 * 1024,
  methods: ["fromUrl", "create", "read"],
} as const satisfies Partial<BlobPolicy>;

/** The largest file self-hosted and local installs store. */
export const maxLocalFileBytes = 2 * 1024 * 1024 * 1024;
/** The default lifetime of a handle when its organization has not chosen one: seven days. */
export const defaultBlobTtlSeconds = 7 * 24 * 60 * 60;
/** An organization may choose any lifetime from one hour... */
export const minBlobTtlSeconds = 60 * 60;
/** ...to one year. */
export const maxBlobTtlSeconds = 365 * 24 * 60 * 60;
/** How long a transfer that never committed keeps its reservation. */
export const pendingBlobSeconds = 60 * 60;

/** One file as the product stores it. */
export interface StoredFileHandle {
  readonly handle: BlobHandle;
  /** Where the bytes live in the user-content store. */
  readonly key: BlobKey;
  /** The app that first stored the file; only it may delete it. */
  readonly creator: string | undefined;
}

/** A reservation the runner streams bytes into before it commits them. */
export interface PendingFileHandle {
  readonly id: string;
  readonly key: BlobKey;
}

/** The result of committing a transfer. */
export interface CommittedFileHandle {
  readonly handle: BlobHandle;
  /**
   * The owner already held a file with these bytes, so `handle` is that file's and the
   * committer's own object is redundant: the caller removes it.
   */
  readonly deduped: boolean;
}

/** A row the sweep owns: its object is removed, then the row. */
export interface ClaimedFileHandle {
  readonly id: string;
  readonly key: BlobKey;
}

/** Product-owned handle metadata. Every method fails with `BlobUnavailable` when storage does. */
export interface FileHandleStore {
  /** Reserve a handle for `owner`. Nothing reads it until `commit`. */
  readonly begin: (input: {
    readonly owner: string;
    readonly appId: string | undefined;
    readonly contentType: string;
  }) => Effect.Effect<PendingFileHandle, BlobUnavailable>;
  /**
   * Publish a reservation once its bytes are stored. The owner's file with the same SHA-256 wins:
   * the reservation is dropped and that file's lifetime extended.
   */
  readonly commit: (input: {
    readonly owner: string;
    readonly id: string;
    readonly size: number;
    readonly sha256: string;
    readonly maxFileBytes: number;
    readonly ttlSeconds: number;
  }) => Effect.Effect<CommittedFileHandle, BlobError>;
  /** Drop a reservation that was never committed. */
  readonly abort: (input: {
    readonly owner: string;
    readonly id: string;
  }) => Effect.Effect<void, BlobUnavailable>;
  /** A live file of `owner`. Another owner's file and an expired one read as `BlobNotFound`. */
  readonly stat: (input: {
    readonly owner: string;
    readonly id: string;
  }) => Effect.Effect<StoredFileHandle, BlobNotFound | BlobUnavailable>;
  /**
   * Hide a file from every reader and return the row for removal. Only the creating app may.
   * `BlobNotFound` for anyone else.
   */
  readonly retire: (input: {
    readonly owner: string;
    readonly id: string;
    readonly appId: string | undefined;
  }) => Effect.Effect<ClaimedFileHandle, BlobNotFound | BlobUnavailable>;
  /** Forget a row whose object is gone. */
  readonly finish: (id: string) => Effect.Effect<void, BlobUnavailable>;
  /**
   * Take up to `limit` rows whose lifetime ended, retired rows and stale reservations, so their
   * objects can be removed. A claimed row is invisible to readers, and a failed removal leaves it
   * to the next sweep.
   */
  readonly claimExpired: (input: {
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ClaimedFileHandle>, BlobUnavailable>;
  /** Retire every file of an owner that no longer exists; the sweep removes the objects. */
  readonly retireOwner: (owner: string) => Effect.Effect<void, BlobUnavailable>;
}

/** Everything a product gives `createExecutor` for file handles. */
export interface UserContentOptions {
  readonly store: BlobStorage;
  readonly handles: FileHandleStore;
  readonly policy: BlobPolicy;
}

/** The user-content key of a file: a folder per owner. Owner names are percent-encoded. */
export const userContentFolder = (owner: string) => encodeURIComponent(owner);

/** What the runner asks the product, bound to one invocation's owner and app. */
export const BlobControlCommand = Schema.Union([
  Schema.Struct({ op: Schema.Literal("limits") }),
  Schema.Struct({ op: Schema.Literal("begin"), contentType: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("commit"),
    id: Schema.String,
    size: Schema.Int,
    sha256: Schema.String,
  }),
  Schema.Struct({ op: Schema.Literal("abort"), id: Schema.String }),
  Schema.Struct({ op: Schema.Literal("stat"), id: Schema.String }),
  Schema.Struct({ op: Schema.Literal("delete"), id: Schema.String }),
]);
export type BlobControlCommand = typeof BlobControlCommand.Type;

/** What `begin` returns: the reservation and the limits the transfer must respect. */
export const BlobBegun = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  maxFileBytes: Schema.Int,
  maxInlineBytes: Schema.Int,
  requiresSize: Schema.Boolean,
});
export type BlobBegun = typeof BlobBegun.Type;
export const BlobCommitted = Schema.Struct({ handle: BlobHandle, deduped: Schema.Boolean });
export const BlobStatted = Schema.Struct({
  handle: BlobHandle,
  key: Schema.String,
  maxReadBytes: Schema.Int,
});
