/** Shared auth and product schema initialization over an acquired SQL client. */
import { selfHostAuthOptions, selfHostAuthSettings } from "./auth-options.ts";
import { makeRegistryStorage } from "@executor-js/app-registry";
import { migrateHostedSchemas, migrationFailed } from "@executor-js/hosted-server/migrations";
import { Effect, Layer, Redacted } from "effect";
import { publishingDomain } from "../contracts/config.ts";
import { selfHostPublishers } from "./publishers.ts";
import { AuthDatabase } from "../contracts/database.ts";
import { makeAuthDatabase } from "./auth-database.ts";
import { migrateSelfHostInstance } from "./instance-schema.ts";
/** Acquire one engine and initialize both schemas before exposing services. */
export const selfHostDatabaseSchema = Layer.effect(
  AuthDatabase,
  Effect.gen(function* () {
    const db = yield* makeAuthDatabase;
    const database = AuthDatabase.of({ db, type: "postgres", transaction: true });
    const settings = yield* selfHostAuthSettings;
    const domain = yield* publishingDomain;
    yield* migrateHostedSchemas(
      {
        // Migrations read plugin schemas only. SSO adds none, so this reads no provider metadata.
        ...selfHostAuthOptions(settings, [], null),
        database,
        secret: Redacted.value(settings.secret),
      },
      migrateSelfHostInstance.pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const registry = yield* makeRegistryStorage(yield* selfHostPublishers(domain));
            yield* registry.migrate.pipe(Effect.mapError(migrationFailed("product")));
          }),
        ),
      ),
    );
    return database;
  }),
);
