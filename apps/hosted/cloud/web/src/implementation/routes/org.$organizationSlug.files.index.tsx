import { createFileRoute } from "@tanstack/react-router";
import { FilesPage } from "@executor-js/hosted-web/pages/files";

/** Files the organization's apps keep, shared by hosted products. */
export const Route = createFileRoute("/org/$organizationSlug/files/")({ component: FilesPage });
