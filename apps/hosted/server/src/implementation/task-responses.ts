/**
 * Tool-call responses as they are stored for task insights. A response only reaches the usage
 * records when the organization turned response recording on. It passes through the same masking
 * as arguments, with one difference: media the response carries is not kept as text. A file handle
 * becomes the address of that file, and inline media (an image block, an embedded blob, a data URI,
 * a long base64 string with a known file signature) is saved as an organization file and replaced
 * by its address, so the Files preview can open it. Credential names are masked before any media
 * is looked for, so a secret is never saved as a file.
 */
import { BlobHandle } from "apps/contracts";
import { fileResourceUri } from "@executor-js/mcp";
import type { FileTransfer } from "@executor-js/sdk/blobs";
import { storeBytes } from "@executor-js/sdk/file-transfer";
import { Effect, Option, Result, Schema, Semaphore } from "effect";
import { Base64 } from "effect/encoding";
import { maskArguments, maskText, truncateUtf8, type MaskIntercept } from "./task-arguments.ts";

/** The most bytes of response JSON kept for one call, marker included. */
export const maxStoredResponseBytes = 16_384;
/** The most media one response may have saved as files. */
const maxMediaPerResponse = 10;
/** The largest one saved file, whatever the organization's file limit allows. */
const maxMediaBytes = 25 * 1024 * 1024;
/** Strings shorter than this are not taken for base64 files. */
const minBase64Length = 1024;

const encoder = new TextEncoder();

/** Inline media waiting to be saved. The bytes stay base64 until they are saved. */
export interface PendingMedia {
  readonly base64: string;
  readonly contentType: string;
  /** The decoded size, from the text's length. */
  readonly size: number;
}

export interface PreparedResponse {
  /** Media to save, in the order `finish` expects their results. */
  readonly media: ReadonlyArray<PendingMedia>;
  /** The JSON to keep, given what each pending media became. Undefined when there is nothing to keep. */
  readonly finish: (replacements: ReadonlyArray<string>) => string | undefined;
}

const formatSize = (bytes: number) => {
  const part = (value: number, unit: string) =>
    `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))} ${unit}`;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return part(bytes / 1024, "KB");
  if (bytes < 1024 * 1024 * 1024) return part(bytes / (1024 * 1024), "MB");
  return part(bytes / (1024 * 1024 * 1024), "GB");
};

/** What stands where media could not be saved. */
export const unsavedMedia = (contentType: string, size: number) =>
  `[${contentType.slice(0, 100)}, ${formatSize(size)}, not saved]`;

const decodedLength = (base64: string) => {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
};

const startsWith = (bytes: Uint8Array, offset: number, text: string) =>
  [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));

/** The media type of well-known file bytes, from their first 12 bytes. */
const signatureType = (bytes: Uint8Array): string | undefined => {
  if (bytes[0] === 0x89 && startsWith(bytes, 1, "PNG")) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (startsWith(bytes, 0, "GIF8")) return "image/gif";
  if (startsWith(bytes, 0, "RIFF") && startsWith(bytes, 8, "WEBP")) return "image/webp";
  if (startsWith(bytes, 0, "RIFF") && startsWith(bytes, 8, "WAVE")) return "audio/wav";
  if (startsWith(bytes, 0, "%PDF")) return "application/pdf";
  if (startsWith(bytes, 0, "ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0))
    return "audio/mpeg";
  if (startsWith(bytes, 0, "OggS")) return "audio/ogg";
  if (startsWith(bytes, 4, "ftyp")) return "video/mp4";
  return undefined;
};

const pureBase64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const dataUriPrefix = /^data:([A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+)(?:;[^;,]*)*;base64,/u;

/** The media type of the file bytes a base64 string starts with, else undefined. */
const base64Signature = (text: string): string | undefined => {
  if (text.length < 16 || text.length % 4 !== 0 || !pureBase64.test(text)) return undefined;
  // 16 characters decode to the 12 bytes every signature fits in.
  const head = Base64.decode(text.slice(0, 16));
  return Result.isSuccess(head) ? signatureType(head.success) : undefined;
};

/** The media type of a long base64 string that holds a known kind of file, else undefined. */
const base64FileType = (text: string): string | undefined =>
  text.length < minBase64Length ? undefined : base64Signature(text);

const savableDeclared = /^(?:image|audio|video)\/|^application\/pdf$/iu;

/**
 * The type to save a string next to a declared mimeType under, or undefined when it is not media:
 * the string must be valid base64 whose first bytes match a known media signature. The declared
 * type is kept when it is image, audio, video or PDF of the same kind as the bytes; otherwise the
 * bytes decide.
 */
const declaredMediaType = (text: string, declared: string): string | undefined => {
  const detected = base64Signature(text);
  if (detected === undefined) return undefined;
  const kind = (type: string) => type.toLowerCase().split("/", 1)[0];
  return savableDeclared.test(declared) && kind(declared) === kind(detected) ? declared : detected;
};

/**
 * Mask a response and find the media in it. `limit` is the largest media worth saving; a limit of
 * 0 saves nothing, and every media becomes a placeholder.
 */
export const prepareResponse = (
  value: unknown,
  options: {
    readonly organization: string;
    readonly extraKeys: ReadonlyArray<string>;
    readonly limit: number;
  },
): PreparedResponse => {
  const limit = Math.min(options.limit, maxMediaBytes);
  const media: PendingMedia[] = [];
  // Marks where saved media goes. Unguessable, so a response cannot forge one.
  const nonce = crypto.randomUUID();
  const mark = (index: number) => `@@media:${nonce}:${index}@@`;
  const take = (base64: string, contentType: string) => {
    const size = decodedLength(base64);
    if (media.length >= maxMediaPerResponse || size > limit) return unsavedMedia(contentType, size);
    media.push({ base64, contentType, size });
    return mark(media.length - 1);
  };
  // A string that masking would change is never saved as a file; it stays text and is masked.
  const unchanged = (text: string) => maskText(text) === text;
  const intercept: MaskIntercept = (node, at) => {
    if (typeof node === "string") {
      if (node.length === 0) return undefined;
      const uri = dataUriPrefix.exec(node);
      if (uri !== null) {
        const payload = node.slice(uri[0].length);
        // Oversized media becomes a placeholder without scanning it.
        if (decodedLength(payload) <= limit && !unchanged(payload)) return undefined;
        return take(payload, uri[1] ?? "");
      }
      const mimeType = at.parent?.mimeType;
      const block = at.parent?.type;
      const declared =
        typeof mimeType === "string" &&
        ((at.key === "data" && (block === "image" || block === "audio")) || at.key === "blob");
      const type =
        declared && typeof mimeType === "string"
          ? declaredMediaType(node, mimeType)
          : base64FileType(node);
      if (type === undefined) return undefined;
      if (decodedLength(node) <= limit && !unchanged(node)) return undefined;
      return take(node, type);
    }
    if (
      typeof node === "object" &&
      node !== null &&
      !Array.isArray(node) &&
      Schema.is(BlobHandle)(node)
    )
      return fileResourceUri(options.organization, node.id);
    return undefined;
  };
  const json = JSON.stringify(maskArguments(value, options.extraKeys, intercept));
  const marks = new RegExp(`@@media:${nonce}:(\\d+)@@`, "gu");
  return {
    media,
    finish: (replacements) => {
      if (json === undefined) return undefined;
      // The replacement sits inside a JSON string, so it is escaped as one.
      const text = json.replace(marks, (_, index: string) =>
        JSON.stringify(replacements[Number(index)] ?? unsavedMedia("media", 0)).slice(1, -1),
      );
      const total = encoder.encode(text).byteLength;
      return total <= maxStoredResponseBytes
        ? text
        : truncateUtf8(text, maxStoredResponseBytes, `…[truncated, ${formatSize(total)} total]`);
    },
  };
};

/** The most media saves running at once; a response arriving beyond that keeps placeholders. */
const saves = Semaphore.makeUnsafe(16);

/**
 * Save each pending media as a file of the organization, made by the tool's app, with the
 * organization's file lifetime. Never fails: one that cannot be saved becomes a placeholder.
 * Results line up with `media`. Beyond the saves already running, all become placeholders.
 */
export const saveResponseMedia = (input: {
  readonly transfer: FileTransfer;
  readonly organization: string;
  readonly owner: string;
  readonly appId: string;
  readonly media: ReadonlyArray<PendingMedia>;
}) =>
  Effect.forEach(input.media, (item) =>
    Effect.gen(function* () {
      const bytes = Base64.decode(item.base64);
      if (Result.isFailure(bytes)) return unsavedMedia(item.contentType, item.size);
      const handle = yield* storeBytes({
        userContent: input.transfer.userContent,
        owner: input.owner,
        appId: input.appId,
        contentType: item.contentType,
        bytes: bytes.success,
        maxBytes: maxMediaBytes,
      });
      return fileResourceUri(input.organization, handle.id);
    }).pipe(
      // The cause can name file content, so it is not logged.
      Effect.catchCause(() => Effect.succeed(unsavedMedia(item.contentType, item.size))),
    ),
  ).pipe(
    saves.withPermitsIfAvailable(1),
    Effect.map(
      Option.getOrElse(() => input.media.map((item) => unsavedMedia(item.contentType, item.size))),
    ),
  );
