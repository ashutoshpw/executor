import type { ReactNode } from "react";
import { OrganizationSwitcher, useOrganizationRoute } from "./organization.tsx";
import { DashboardFrame } from "./dashboard-frame.tsx";
import type { CommandBarItem } from "./command-bar.tsx";

/** Organization and session controls belong to the hosted product, outside the shared shell. */
export function DashboardShell({
  navigation,
  banner,
  support,
  notice,
  commandItems,
  children,
  allowCreateOrganization = true,
}: {
  readonly navigation: ReactNode;
  readonly banner?: ReactNode;
  readonly support?: ReactNode;
  readonly notice?: ReactNode;
  readonly commandItems?: ReadonlyArray<CommandBarItem> | undefined;
  readonly children: ReactNode;
  readonly allowCreateOrganization?: boolean;
}) {
  const { slug: organizationSlug } = useOrganizationRoute();
  return (
    <DashboardFrame
      organizationSlug={organizationSlug}
      organization={<OrganizationSwitcher allowCreate={allowCreateOrganization} />}
      navigation={navigation}
      banner={banner}
      support={support}
      notice={notice}
      commandItems={commandItems}
    >
      {children}
    </DashboardFrame>
  );
}
