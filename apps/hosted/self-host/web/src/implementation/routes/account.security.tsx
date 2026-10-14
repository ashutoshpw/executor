import { createFileRoute } from "@tanstack/react-router";
import { parseAccountSearch } from "@executor-js/hosted-web/contracts/navigation";
import { SecurityPending } from "@executor-js/hosted-web/account";
import { SecurityPage } from "@executor-js/hosted-web/pages/security";
import { ChangePassword, ChangePasswordPending } from "../components/change-password.tsx";
import { InstanceOwnership } from "../components/instance-ownership.tsx";

/** Self-host signs in with a password (or SSO); the password is changed here, and the owner manages the instance. */
export const Route = createFileRoute("/account/security")({
  validateSearch: parseAccountSearch,
  pendingComponent: () => (
    <SecurityPending>
      <ChangePasswordPending />
    </SecurityPending>
  ),
  component: () => (
    <SecurityPage>
      <ChangePassword />
      <InstanceOwnership />
    </SecurityPage>
  ),
});
