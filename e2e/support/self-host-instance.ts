/** Requests to an isolated self-host instance as people it was set up for, each with their own cookies. */
import { Schema } from "effect";
import { driver } from "./platform.ts";

/** The cookies a response sets, leaving out those it clears. */
export const cookieOf = (headers: Headers) =>
  headers
    .getSetCookie()
    .map((part) => part.split(";")[0] ?? "")
    .filter((pair) => !pair.endsWith("="))
    .join("; ");

/** The product API at `origin`, called with the cookies of whoever `cookie` names. */
export const instanceClient = (origin: string) => ({
  request: (cookie: string, method: "GET" | "POST", path: string, data?: unknown) =>
    driver(`${method} ${path}`, () =>
      fetch(`${origin}${path}`, {
        method,
        headers: {
          origin,
          ...(data === undefined ? {} : { "content-type": "application/json" }),
          ...(cookie === "" ? {} : { cookie }),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }).then((response) =>
        response.text().then((text) => ({
          status: response.status,
          body: (text === "" ? null : JSON.parse(text)) as unknown,
          cookie: cookieOf(response.headers),
        })),
      ),
    ),
  /** Decode a response body the scenario expects to be shaped as `schema`. */
  decode: <S extends Schema.Decoder<unknown>>(schema: S, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value),
});
