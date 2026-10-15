/** Task insights: the tasks agents worked on, and the ordered calls of one task. */
import { Data } from "effect";
import { Atom } from "effect/reactivity";
import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import type { UsageRange } from "@executor-js/hosted-server/usage";
import { HostedClient } from "./api.ts";
import { protectedQuery } from "./protected-query.ts";

/** One page of the task list: the range, and the cursor it continues from. */
class TasksKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly range: UsageRange;
  readonly after: string | undefined;
}> {}
const pages = Atom.family((key: TasksKey) =>
  HostedClient.query(
    "tasks",
    "list",
    hydrated({
      params: { organization: key.organization },
      query: { range: key.range, ...(key.after === undefined ? {} : { after: key.after }) },
    }),
  ).pipe(revalidated, protectedQuery),
);
export const tasksAtom = (
  organization: OrganizationReference,
  range: UsageRange,
  after: string | undefined,
) => pages(new TasksKey({ organization, range, after }));

class TaskKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly range: UsageRange;
  readonly key: string;
}> {}
const detail = Atom.family((key: TaskKey) =>
  HostedClient.query(
    "tasks",
    "get",
    hydrated({
      params: { organization: key.organization },
      query: { key: key.key, range: key.range },
    }),
  ).pipe(revalidated, protectedQuery),
);
export const taskAtom = (organization: OrganizationReference, range: UsageRange, key: string) =>
  detail(new TaskKey({ organization, range, key }));
