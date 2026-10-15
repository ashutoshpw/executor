/**
 * Files in MCP. A tool returns a small `BlobHandle` inside its value; the result then also carries
 * a `resource_link` to `executor-file://<org>/<id>`, and a client that wants the bytes asks for
 * them with `resources/read`. The bytes never travel in a tool result. The 100,000-byte output
 * ceiling applies to the execution value, before links are added; the links then add at most
 * `maxLinkBytes` of metadata (20 links of a few hundred bytes), so a result is never larger than
 * the ceiling plus that fixed allowance.
 *
 * One handle has one authorization. The backend decides who may stat or read a file from the
 * caller's authenticated request; the organization in the URI is advisory and only compared.
 */
import { BlobHandle } from "apps/contracts";
import { Cause, Context, Effect, Layer, Result, Schema } from "effect";
import { McpSchema, McpServer } from "effect/ai";
import type { McpBackend } from "../contracts/backend.ts";

/** The `resource_link` block arrived with MCP 2025-06-18; older clients get the unchanged result. */
const linkProtocols: ReadonlySet<string> = new Set(["2025-06-18", "2025-11-25", "2026-07-28"]);
/** Tools whose results can hold a handle: the ones that run app tools. */
const linkingTools: ReadonlySet<string> = new Set(["call", "execute", "resume"]);

/** The most a scan visits, so a hostile result cannot make the decorator work unboundedly. */
const scanLimits = { depth: 8, nodes: 2_000, links: 20 } as const;
/** The most serialized link metadata one result gains, on top of the execution value's ceiling. */
export const maxLinkBytes = 16_000;

/** What a template URI names: `executor-file://<organization>/<handle id>`. */
export const fileResourceTemplate = "executor-file://{org}/{id}";
const scheme = "executor-file://";

export const fileResourceUri = (organization: string, id: string) =>
  `${scheme}${encodeURIComponent(organization)}/${encodeURIComponent(id)}`;

/** The two segments of a file URI, or undefined when the URI is not exactly one. */
export const parseFileResourceUri = (
  uri: string,
): { readonly organization: string; readonly id: string } | undefined => {
  if (!uri.startsWith(scheme)) return undefined;
  const segments = uri.slice(scheme.length).split("/");
  if (segments.length !== 2) return undefined;
  try {
    const [organization, id] = segments.map((segment) => decodeURIComponent(segment));
    return organization === undefined ||
      id === undefined ||
      organization === "" ||
      id === "" ||
      id === ".." ||
      id === "." ||
      organization === ".." ||
      organization === "."
      ? undefined
      : { organization, id };
  } catch {
    return undefined;
  }
};

const isHandle = Schema.is(BlobHandle);

/**
 * Every value in `value` shaped like a file handle, in the order found and without repeats. The
 * match is structural, so it proves nothing about who owns the file: callers check each candidate
 * with the backend before linking it.
 */
export const collectFileHandles = (
  value: unknown,
  limits: Partial<typeof scanLimits> = {},
): ReadonlyArray<BlobHandle> => {
  const { depth: maxDepth, nodes: maxNodes, links: maxLinks } = { ...scanLimits, ...limits };
  const found = new Map<string, BlobHandle>();
  let visited = 0;
  const queue: Array<readonly [unknown, number]> = [[value, 0]];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [node, depth] = next;
    if (typeof node !== "object" || node === null) continue;
    if (++visited > maxNodes || found.size >= maxLinks) break;
    if (isHandle(node)) {
      if (!found.has(node.id)) found.set(node.id, node);
      continue;
    }
    if (depth >= maxDepth) continue;
    for (const child of Array.isArray(node) ? node : Object.values(node))
      queue.push([child, depth + 1]);
  }
  return [...found.values()];
};

/** The value a completed program or call returned, when it has one. */
const returnedValue = (structured: unknown): unknown => {
  if (typeof structured !== "object" || structured === null) return undefined;
  const execution = (structured as { readonly execution?: unknown }).execution;
  if (typeof execution !== "object" || execution === null) return undefined;
  const { ok, value } = execution as { readonly ok?: unknown; readonly value?: unknown };
  return ok === true ? value : undefined;
};

/**
 * The same toolkit with `resource_link` blocks appended after a completed `call`, `execute` or
 * `resume` result that returned file handles the caller owns. The text block and
 * `structuredContent` stay exactly as the toolkit built them.
 */
const withFileLinks = (backend: McpBackend<Error>) =>
  Layer.effect(
    McpServer.McpServer,
    Effect.gen(function* () {
      const base = yield* McpServer.McpServer;
      const addTool: (typeof base)["addTool"] = (options) => {
        if (!linkingTools.has(options.tool.name)) return base.addTool(options);
        return base.addTool({
          ...options,
          handle: (payload) =>
            options
              .handle(payload)
              .pipe(
                Effect.flatMap((result) =>
                  result instanceof McpSchema.CallToolResult && result.isError !== true
                    ? Effect.flatMap(McpSchema.McpRequestContext, (context) =>
                        linkProtocols.has(context.protocolVersion)
                          ? linked(backend, result)
                          : Effect.succeed(result),
                      )
                    : Effect.succeed(result),
                ),
              ),
        });
      };
      // The service holds its registries behind getters, so copy descriptors, not values.
      return Object.defineProperties(
        {},
        {
          ...Object.getOwnPropertyDescriptors(base),
          addTool: { value: addTool, enumerable: true },
        },
      ) as typeof base;
    }),
  );

/**
 * `McpServer.toolkit` with `resource_link` blocks appended after a completed `call`, `execute` or
 * `resume` result that returned file handles the caller owns. The text block and
 * `structuredContent` stay exactly as the toolkit built them.
 *
 * `McpServer.toolkit` provides its own `McpServer.layer`, so a decorated service handed in from
 * outside never reaches it; this registers through the decorated one instead. Every layer shares
 * one `McpServer` through the memo map, so tools, events and the file template meet in one registry.
 */
export const toolkitWithFileLinks =
  (backend: McpBackend<Error>): typeof McpServer.toolkit =>
  (toolkit) =>
    Layer.effectDiscard(McpServer.registerToolkit(toolkit)).pipe(
      Layer.provide(withFileLinks(backend)),
      Layer.provide(McpServer.McpServer.layer),
    );

const linked = (backend: McpBackend<Error>, result: McpSchema.CallToolResult) =>
  Effect.gen(function* () {
    const candidates = collectFileHandles(returnedValue(result.structuredContent));
    if (candidates.length === 0) return result;
    const organization = yield* backend.files.organization;
    // A handle the caller cannot stat is forged, expired or someone else's: it gets no link.
    const owned = yield* Effect.forEach(
      candidates,
      (candidate) =>
        backend.files.stat({ id: candidate.id }).pipe(
          Effect.map(({ handle }) => handle),
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
      { concurrency: 4 },
    );
    const built = owned.flatMap((handle) =>
      handle === undefined
        ? []
        : [
            {
              type: "resource_link" as const,
              uri: fileResourceUri(organization, handle.id),
              name: handle.id,
              mimeType: handle.contentType,
              size: handle.size,
              annotations: { audience: ["assistant" as const] },
              _meta: { sha256: handle.sha256, expiresAt: handle.expiresAt },
            },
          ],
    );
    // Links are accounted against a fixed byte allowance; a link that would pass it is dropped.
    let budget = maxLinkBytes;
    const links = built.filter((link) => {
      budget -= JSON.stringify(link).length;
      return budget >= 0;
    });
    return links.length === 0
      ? result
      : new McpSchema.CallToolResult({ ...result, content: [...result.content, ...links] });
  }).pipe(Effect.catchCause(() => Effect.succeed(result)));

/** MCP's "resource not found" code. Missing, expired, forged and other-organization files share it. */
const resourceNotFoundCode = -32002;
const notFound = (uri: string) =>
  new McpSchema.McpErrorBase({
    code: resourceNotFoundCode,
    message: "Resource not found",
    data: { uri },
  });

const invalid = (message: string, data?: unknown) =>
  new McpSchema.InvalidParams({ message, ...(data === undefined ? {} : { data }) });

type FileReadError = McpSchema.McpErrorBase | McpSchema.InvalidParams | McpSchema.InternalError;

/** `resources/read` of one file, answered from the backend. */
const readFile = (
  backend: McpBackend<Error>,
  uri: string,
): Effect.Effect<McpSchema.ReadResourceResult, FileReadError> =>
  Effect.gen(function* () {
    const parsed = parseFileResourceUri(uri);
    if (parsed === undefined) return yield* Effect.fail(notFound(uri));
    const { handle, contents } = yield* backend.files.read(parsed);
    const meta = { sha256: handle.sha256, size: handle.size, expiresAt: handle.expiresAt };
    return {
      contents: [
        contents._tag === "text"
          ? { uri, mimeType: handle.contentType, text: contents.text, _meta: meta }
          : { uri, mimeType: handle.contentType, blob: contents.bytes, _meta: meta },
      ],
    } satisfies McpSchema.ReadResourceResult;
  }).pipe(
    Effect.catchCause((cause): Effect.Effect<never, FileReadError> => {
      const failure = Cause.findFail(cause);
      const error: unknown = Result.isSuccess(failure) ? failure.success.error : undefined;
      if (error instanceof McpSchema.McpErrorBase) return Effect.fail(error);
      switch ((error as { readonly _tag?: string } | undefined)?._tag) {
        case "InvalidParams":
          return Effect.fail(error as McpSchema.InvalidParams);
        case "FileNotFound":
          return Effect.fail(notFound(uri));
        case "FileForbidden":
          return Effect.fail(
            invalid("This connection is not permitted to read files", { _tag: "FileForbidden" }),
          );
        case "FilesUnavailable":
          // The store could not answer: a server fault, not a client mistake.
          return Effect.fail(
            new McpSchema.InternalError({ message: "This server cannot read files right now" }),
          );
        case "FileTooLargeForResource": {
          const { id, size, maximum, sha256, url, expiresAt } = error as {
            readonly id: string;
            readonly size: number;
            readonly maximum: number;
            readonly sha256: string;
            readonly url?: string;
            readonly expiresAt?: string;
          };
          const cli = `executor files get ${id}`;
          return Effect.fail(
            invalid(
              `File ${id} is ${size} bytes, over this server's resource read limit of ${maximum} bytes. ${
                url === undefined
                  ? `Download it with: ${cli}`
                  : `Download it from ${url} (valid until ${expiresAt ?? "it expires"}) or run: ${cli}`
              }`,
              {
                _tag: "FileTooLarge",
                id,
                size,
                maxResourceReadBytes: maximum,
                sha256,
                ...(url === undefined ? {} : { url }),
                ...(expiresAt === undefined ? {} : { expiresAt }),
                cli,
              },
            ),
          );
        }
        default:
          // A defect or an error this module does not know: logged here, never shown to the client.
          return Effect.logError(cause).pipe(
            Effect.andThen(Effect.fail(new McpSchema.InternalError({ message: "Internal error" }))),
          );
      }
    }),
  );

/**
 * The one resource template. `resources/list` stays empty: static resources are server-global, so
 * listing files there would leak across organizations, and enumerating them is unbounded.
 */
export const fileResource = (backend: McpBackend<Error>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* McpServer.McpServer;
      // `::` escapes the scheme's colon in the router's path syntax.
      yield* registry.addResourceTemplate({
        template: new McpSchema.ResourceTemplate({
          uriTemplate: fileResourceTemplate,
          name: "Executor file",
          description:
            "A file an app tool returned by handle, named by a resource_link in the tool's result. Reads return at most the server's resource limit; a larger file fails with a signed download link. File bytes never appear in tool results.",
        }),
        annotations: Context.empty(),
        routerPath: "executor-file:://:0/:1",
        completions: {},
        // The template's handler type admits only InvalidParams and InternalError, but the wire
        // encoder accepts any McpErrorBase, which is how MCP's -32002 reaches the client.
        handle: (uri) =>
          readFile(backend, uri) as Effect.Effect<
            McpSchema.ReadResourceResult,
            McpSchema.InvalidParams | McpSchema.InternalError
          >,
      });
    }),
  );
