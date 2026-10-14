import { createFileRoute } from "@tanstack/react-router";
import { DashboardEntryPending } from "@executor-js/hosted-web/entry";
import { OrganizationEntry } from "@executor-js/hosted-web/organization";
import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { instanceOwnerAtom } from "../../contracts/auth.ts";

/** Resolve an initial destination when no usable recent-organization hint exists. */
export const Route = createFileRoute("/")({
  component: RootEntry,
  // The entry's own loading view, while the server reads the memberships.
  pendingComponent: () => <DashboardEntryPending />,
});

function RootEntry() {
  const instanceOwner = Option.getOrElse(
    AsyncResult.value(useAtomValue(instanceOwnerAtom)),
    () => false,
  );
  return <OrganizationEntry allowCreate={instanceOwner} />;
}
