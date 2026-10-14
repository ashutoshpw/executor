/** The organization's file lifetime: one read, replaced by the confirmed save. */
import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { Atom } from "effect/reactivity";
import { Effect } from "effect";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { acknowledge, acknowledgedQuery } from "@executor-js/ui/contracts/mutations";
import { HostedClient } from "./api.ts";

/** Keep the confirmed setting visible while background reconciliation runs. */
export const blobSettingsAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.query("blobSettings", "get", hydrated({ params: { organization } })).pipe(
    revalidated,
    acknowledgedQuery,
  ),
);

/** Save a lifetime in seconds; the server's answer replaces the view, never a local guess. */
export const saveBlobSettingsAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn((ttlSeconds: number, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.blobSettings.update({ params: { organization }, payload: { ttlSeconds } }),
    ).pipe(
      Effect.tap((saved) =>
        Effect.sync(() => acknowledge(get, blobSettingsAtom(organization), () => saved)),
      ),
    ),
  ),
);
