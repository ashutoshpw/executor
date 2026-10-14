import { createFileRoute } from "@tanstack/react-router";
import { parseHomeSearch } from "@executor-js/hosted-web/contracts/navigation";
import { defaultRange, HomePage } from "@executor-js/hosted-web/pages/home";

export const Route = createFileRoute("/org/$organizationSlug/")({
  validateSearch: parseHomeSearch,
  component: Home,
});
function Home() {
  const { range } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <HomePage
      range={range}
      onRangeChange={(next) =>
        void navigate({
          search: { range: next === defaultRange ? undefined : next },
          replace: true,
        })
      }
    />
  );
}
