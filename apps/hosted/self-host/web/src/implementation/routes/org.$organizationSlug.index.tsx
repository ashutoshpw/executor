import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "@executor-js/hosted-web/pages/home";

export const Route = createFileRoute("/org/$organizationSlug/")({
  component: HomePage,
});
