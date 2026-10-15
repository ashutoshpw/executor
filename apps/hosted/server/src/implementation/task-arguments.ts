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
  /password|passwd|pass|pwd|passphrase|secret|token|api[_-]?key|apikey|auth|authorization|cookie|credential|bearer|private[_-]?key|session|dsn|connection.?string|access.?key|signing.?key|encryption.?key|license.?key|(^|[_-])key$/i;
/** camelCase names ending in Key (apiKey, stripeKey); case matters, so it is kept apart. */
const camelKey = /[a-z]Key$/;

const credentialName = (name: string) => credentialKey.test(name) || camelKey.test(name);

/** Fields that name the value beside them in a name/value pair, such as an HTTP header entry. */
const pairNameFields: ReadonlyArray<string> = ["name", "key", "header", "headerName", "field"];
const pairValueFields: ReadonlyArray<string> = ["value", "val"];

/** Text that looks like a credential whatever key it sits under. Matches are replaced in place. */
const credentialValues: ReadonlyArray<RegExp> = [
  // JWT: three base64url segments, the first a JSON header.
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/g,
  // OpenAI-, Anthropic- and Stripe-style secret keys.
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // GitHub and GitLab tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  // Slack tokens.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // AWS access key IDs.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Google API keys, SendGrid keys and npm tokens.
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  // PEM blocks (private keys, certificates), through their end line when there is one.
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g,
];
/** user:password@ in a URL; the scheme and host stay. */
const urlCredentials = /:\/\/[^\s/:@]+:[^\s/@]+@/g;

/** The text with every credential-looking part replaced, wherever it sits in the string. */
export const maskText = (value: string): string => {
  let text = value.replace(urlCredentials, `://${maskedValue}@`);
  for (const pattern of credentialValues) text = text.replace(pattern, maskedValue);
  return text;
};

/** Where a value sits: the object it is a field of and its name there. Both absent at the root and in arrays. */
export interface MaskPosition {
  readonly parent: Readonly<Record<string, unknown>> | undefined;
  readonly key: string | undefined;
}

/**
 * Offered every string and object that is not under a credential name, before it is masked or
 * visited. A result other than undefined replaces the value as it is, so a value that was
 * intercepted is never inspected again; credential names are decided first, so the hook never
 * sees a secret.
 */
export type MaskIntercept = (node: unknown, at: MaskPosition) => unknown;

/** Replace credential keys and values in a JSON-like value, to a bounded depth and size. */
export const maskArguments = (
  value: unknown,
  extraKeys: ReadonlyArray<string> = [],
  intercept?: MaskIntercept,
): unknown => {
  const extra = new Set(
    extraKeys.map((key) => key.trim().toLowerCase()).filter((key) => key !== ""),
  );
  const seen = new WeakSet<object>();
  let nodes = 0;
  const isSecretName = (name: string) =>
    credentialName(name) || extra.has(name.trim().toLowerCase());
  const maskObject = (node: object, depth: number) => {
    const fields = node as Record<string, unknown>;
    // In a name/value pair the name decides whether the value is secret: {name: "X-Api-Key", value}.
    const secretPair = pairNameFields.some((field) => {
      const name = fields[field];
      return typeof name === "string" && isSecretName(name);
    });
    return Object.fromEntries(
      Object.entries(fields).map(([key, item]) => [
        key,
        isSecretName(key) || (secretPair && pairValueFields.includes(key))
          ? maskedValue
          : visit(item, depth + 1, { parent: fields, key }),
      ]),
    );
  };
  const noPosition: MaskPosition = { parent: undefined, key: undefined };
  const visit = (node: unknown, depth: number, at: MaskPosition = noPosition): unknown => {
    nodes += 1;
    if (nodes > maxNodes) return "[omitted]";
    const replaced = intercept?.(node, at);
    if (replaced !== undefined) return replaced;
    if (typeof node === "string") return maskText(node);
    if (typeof node === "bigint") return node.toString();
    if (typeof node === "function" || typeof node === "symbol") return undefined;
    if (typeof node !== "object" || node === null) return node;
    if (seen.has(node)) return "[circular]";
    if (depth >= maxDepth) return "[depth limit]";
    seen.add(node);
    const masked = Array.isArray(node)
      ? node.map((item) => visit(item, depth + 1))
      : maskObject(node, depth);
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
