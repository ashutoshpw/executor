/** The organization's files: one read per page of the listing, and the actions on a file. */
import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { acknowledgedQuery } from "@executor-js/ui/contracts/mutations";
import { Atom } from "effect/reactivity";
import { Data, Effect } from "effect";
import type { AppId } from "@executor-js/sdk/core";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { HostedClient } from "./api.ts";

/** One page of the listing: the app it is filtered to, and the cursor it continues from. */
class FilesKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId | undefined;
  readonly after: string | undefined;
  /** A new generation reads the listing again, as after a delete. */
  readonly generation: number;
}> {}

const pages = Atom.family((key: FilesKey) =>
  HostedClient.query(
    "organizationFiles",
    "list",
    hydrated({
      params: { organization: key.organization },
      query: {
        ...(key.app === undefined ? {} : { app: key.app }),
        ...(key.after === undefined ? {} : { after: key.after }),
      },
    }),
  ).pipe(revalidated, acknowledgedQuery),
);
export const filesAtom = (key: ConstructorParameters<typeof FilesKey>[0]) =>
  pages(new FilesKey(key));

/** Delete a file; the page reads the listing again once the server confirms. */
export const deleteFileAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn((handle: string) =>
    Effect.flatMap(HostedClient, (client) =>
      client.organizationFiles.delete({ params: { organization, handle } }),
    ),
  ),
);

/** A download link for a file (15 minutes unless `expiresInSeconds` asks for more), from the route that applies the file's visibility. */
export const downloadLinkAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn(
    (input: { readonly handle: string; readonly expiresInSeconds?: number }) =>
      Effect.flatMap(HostedClient, (client) =>
        client.files.downloadUrl({
          params: { organization, handle: input.handle },
          payload:
            input.expiresInSeconds === undefined
              ? {}
              : { expiresInSeconds: input.expiresInSeconds },
        }),
      ),
  ),
);
