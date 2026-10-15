import { createFileRoute } from "@tanstack/react-router";
import { parseTasksSearch } from "@executor-js/hosted-web/contracts/navigation";
import { defaultRange } from "@executor-js/hosted-web/pages/home";
import { TasksPage } from "@executor-js/hosted-web/pages/tasks";

/** The tool calls agents made for each task; owners and admins only. */
export const Route = createFileRoute("/org/$organizationSlug/tasks/")({
  validateSearch: parseTasksSearch,
  component: Tasks,
});
function Tasks() {
  const { range, task } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <TasksPage
      range={range}
      task={task}
      onRangeChange={(next) =>
        void navigate({
          search: (previous) => ({
            ...previous,
            range: next === defaultRange ? undefined : next,
          }),
          replace: true,
        })
      }
      onTaskChange={(next) =>
        void navigate({ search: (previous) => ({ ...previous, task: next }) })
      }
    />
  );
}
