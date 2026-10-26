import { useAtomMount } from "@effect/atom-react";
import { HostedFailure, useDashboardAtoms } from "../components/dashboard-bindings.tsx";
import { Link } from "@tanstack/react-router";
import { CatalogPage as Catalog } from "@executor-js/ui/dashboard/catalog";
import { appManagement } from "../../contracts/app-management.ts";
import { acknowledgeApp } from "../../contracts/apps.ts";
import { useOrganizationRoute } from "../components/organization.tsx";
import { MakeYourOwn, AddAppBack } from "../components/add-app.tsx";

/** Catalog apps and public listings install into the same organization-owned app records. */
export function AddAppPage() {
  const atoms = useDashboardAtoms();
  useAtomMount(atoms.catalog);
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const management = appManagement(organization);
  return (
    <Catalog
      query={atoms.catalog}
      Failure={HostedFailure}
      mutation={atoms.install}
      InstallFailure={HostedFailure}
      inventory={atoms.inventory}
      publications={management.catalog}
      PublicationFailure={HostedFailure}
      copy={(publication) =>
        management.copy({ package: publication.name, commit: publication.commit })
      }
      onApp={(get, saved) => acknowledgeApp(get, organization, saved)}
      open={(app) => (
        <Link
          to="/org/$organizationSlug/apps/$appId"
          search={{ view: Object.keys(app.requirements.accounts).length ? "accounts" : "overview" }}
          params={{ organizationSlug, appId: app.id }}
        >
          Open
        </Link>
      )}
      back={<AddAppBack organizationSlug={organizationSlug} />}
      action={<MakeYourOwn appearance="button" />}
      create={<MakeYourOwn />}
    />
  );
}
