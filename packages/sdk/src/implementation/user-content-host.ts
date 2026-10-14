/**
 * The product's side of the runner's user-content transfers: the objects the runner reads and
 * writes through its `HOST` binding. Only the trusted apps Worker holds that binding, so the
 * request carries no credentials; a key must still be a well-formed user-content key.
 */
import { Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { BlobKey, type BlobStorage } from "../contracts/blobs.ts";
import { rangeHeader, sizeHeader, userContentPath } from "./host-user-content.ts";

const Range = Schema.Struct({
  offset: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  length: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
const Size = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

const failed = (status: number) => Effect.succeed(HttpServerResponse.empty({ status }));

/** Answer one transfer request against the product's user-content store. */
export const userContentRequest = (store: BlobStorage) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const key = yield* Schema.decodeUnknownEffect(BlobKey)(
      new URL(request.url, "https://host.internal").pathname.slice(userContentPath.length),
    );
    switch (request.method) {
      case "PUT": {
        const declared = request.headers[sizeHeader];
        const size =
          declared === undefined ? undefined : yield* Schema.decodeUnknownEffect(Size)(declared);
        yield* store.putStream(key, request.stream, size === undefined ? {} : { size });
        return HttpServerResponse.empty({ status: 204 });
      }
      case "HEAD":
        return HttpServerResponse.empty({ status: (yield* store.exists(key)) ? 200 : 404 });
      case "GET": {
        const window = request.headers[rangeHeader];
        const range =
          window === undefined
            ? undefined
            : yield* Schema.decodeUnknownEffect(Range)({
                offset: window.split(",")[0],
                length: window.split(",")[1],
              });
        const found = yield* store.stream(key, range);
        if (found._tag === "None") return HttpServerResponse.empty({ status: 404 });
        return HttpServerResponse.stream(found.value.body, {
          headers: {
            [sizeHeader]: String(found.value.size),
            "content-type": "application/octet-stream",
          },
        });
      }
      case "DELETE":
        yield* store.remove(key);
        return HttpServerResponse.empty({ status: 204 });
      default:
        return HttpServerResponse.empty({ status: 405 });
    }
  }).pipe(
    Effect.catch((error) =>
      Schema.isSchemaError(error)
        ? failed(400)
        : Effect.logWarning("A user-content transfer failed").pipe(Effect.andThen(failed(500))),
    ),
  );
