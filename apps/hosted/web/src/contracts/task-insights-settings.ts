/** The organization's task insights setting: one read, replaced by the confirmed save. */
import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { Atom } from "effect/reactivity";
import { Effect } from "effect";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import type { TaskInsightsSettingsUpdate } from "@executor-js/hosted-server/task-insights-settings";
import { acknowledge, acknowledgedQuery } from "@executor-js/ui/contracts/mutations";
import { HostedClient } from "./api.ts";

/** Keep the confirmed setting visible while background reconciliation runs. */
export const taskInsightsSettingsAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.query("taskInsightsSettings", "get", hydrated({ params: { organization } })).pipe(
    revalidated,
    acknowledgedQuery,
  ),
);

/** Save the setting; the server's answer replaces the view, never a local guess. */
export const saveTaskInsightsSettingsAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn((payload: TaskInsightsSettingsUpdate, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.taskInsightsSettings.update({ params: { organization }, payload }),
    ).pipe(
      Effect.tap((saved) =>
        Effect.sync(() => acknowledge(get, taskInsightsSettingsAtom(organization), () => saved)),
      ),
    ),
  ),
);
