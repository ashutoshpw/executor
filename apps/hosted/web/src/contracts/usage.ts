/** Usage insights read from the host's own records; the range selects the window. */
import { Data } from "effect";
import { Atom } from "effect/reactivity";
import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import type { UsageRange } from "@executor-js/hosted-server/usage";
import { HostedClient } from "./api.ts";
import { protectedQuery } from "./protected-query.ts";

class UsageKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly range: UsageRange;
}> {}
const report = Atom.family((key: UsageKey) =>
  HostedClient.query(
    "usage",
    "get",
    hydrated({ params: { organization: key.organization }, query: { range: key.range } }),
  ).pipe(revalidated, protectedQuery),
);
export const usageAtom = (organization: OrganizationReference, range: UsageRange) =>
  report(new UsageKey({ organization, range }));
