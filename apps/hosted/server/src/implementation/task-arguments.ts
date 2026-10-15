/**
 * Tool-call arguments as they are stored for task insights. Arguments only reach the usage records
 * when the organization turned recording on, and always pass through `storedArguments` first:
 * credential-looking keys and values are replaced, and the JSON is capped.
 */

export const maskedValue = "[masked]";
export const truncationMarker = "…[truncated]";
/** The most bytes of JSON kept for one call, marker included. */
export const maxStoredArgumentBytes = 4096;
const maxDepth = 12;
const maxNodes = 5_000;

/** Names whose values are credentials or session material. A name is masked when it contains one. */
const credentialKey =
  /password|passwd|secret|token|api[_-]?key|apikey|auth|authorization|cookie|credential|bearer|private[_-]?key|session/i;

/** Text that looks like a credential whatever key it sits under. The whole value is replaced. */
const credentialValues: ReadonlyArray<RegExp> = [
  // JWT: three base64url segments, the first a JSON header.
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  // OpenAI-, Anthropic- and Stripe-style secret keys.
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  // Slack tokens.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  // AWS access key IDs.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  // PEM blocks (private keys, certificates).
  /-----BEGIN [A-Z0-9 ]+-----/,
];

const looksLikeCredential = (value: string) =>
  credentialValues.some((pattern) => pattern.test(value));

/** Replace credential keys and values in a JSON-like value, to a bounded depth and size. */
export const maskArguments = (value: unknown, extraKeys: ReadonlyArray<string> = []): unknown => {
  const extra = new Set(
    extraKeys.map((key) => key.trim().toLowerCase()).filter((key) => key !== ""),
  );
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (node: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > maxNodes) return "[omitted]";
    if (typeof node === "string") return looksLikeCredential(node) ? maskedValue : node;
    if (typeof node === "bigint") return node.toString();
    if (typeof node === "function" || typeof node === "symbol") return undefined;
    if (typeof node !== "object" || node === null) return node;
    if (seen.has(node)) return "[circular]";
    if (depth >= maxDepth) return "[depth limit]";
    seen.add(node);
    const masked = Array.isArray(node)
      ? node.map((item) => visit(item, depth + 1))
      : Object.fromEntries(
          Object.entries(node).map(([key, item]) => [
            key,
            credentialKey.test(key) || extra.has(key.toLowerCase())
              ? maskedValue
              : visit(item, depth + 1),
          ]),
        );
    seen.delete(node);
    return masked;
  };
  return visit(value, 0);
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Cut text to a byte budget on a character boundary, and mark that it was cut. */
export const truncateUtf8 = (
  text: string,
  maxBytes: number = maxStoredArgumentBytes,
  marker: string = truncationMarker,
): string => {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  let end = Math.max(0, maxBytes - encoder.encode(marker).byteLength);
  // A continuation byte at the cut would split a character, so back up to the character's start.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return decoder.decode(bytes.subarray(0, end)) + marker;
};

/**
 * The JSON text to keep for a call's arguments, or undefined when there is nothing to keep.
 * Masking happens first, so a credential never reaches the cap or the store.
 */
export const storedArguments = (
  value: unknown,
  extraKeys: ReadonlyArray<string> = [],
): string | undefined => {
  if (value === undefined) return undefined;
  const text = JSON.stringify(maskArguments(value, extraKeys));
  return text === undefined ? undefined : truncateUtf8(text);
};
