import { createFileRoute } from "@tanstack/react-router";
import { parseFilesSearch } from "@executor-js/hosted-web/contracts/navigation";
import { FilesPage } from "@executor-js/hosted-web/pages/files";

/** Files the organization's apps keep, shared by hosted products. */
export const Route = createFileRoute("/org/$organizationSlug/files/")({
  validateSearch: parseFilesSearch,
  component: Files,
});
function Files() {
  const { app, file } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <FilesPage
      app={app}
      file={file}
      onAppChange={(next) =>
        void navigate({ search: (previous) => ({ ...previous, app: next }), replace: true })
      }
      onFileChange={(next) =>
        void navigate({ search: (previous) => ({ ...previous, file: next }) })
      }
    />
  );
}
