import { createFileRoute } from "@tanstack/react-router";
import { parseOrganizationSearch } from "@executor-js/hosted-web/contracts/navigation";
import { OrganizationPage } from "@executor-js/hosted-web/pages/organization";

/** Organization administration shared by both hosts. */
export const Route = createFileRoute("/org/$organizationSlug/organization")({
  validateSearch: parseOrganizationSearch,
  component: SelfHostOrganizationPage,
});

function SelfHostOrganizationPage() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <OrganizationPage
      tab={tab}
      onTabChange={(next) => void navigate({ search: { tab: next }, replace: true })}
    />
  );
}
