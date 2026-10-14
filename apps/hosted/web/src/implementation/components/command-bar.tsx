import { useMemo } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Option } from "effect";
import { type IconSvgElement } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  BoxesIcon,
  Building03Icon,
  Logout01Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import {
  CommandPalette,
  type CommandPaletteGroup,
} from "@executor-js/ui/components/command-palette";
import { organizationsAtom } from "../../contracts/organization.ts";
import { parseAccountSearch } from "../../contracts/navigation.ts";
import { resourceInventoryAtom } from "../../contracts/resource-access.ts";
import { signOutAtom } from "../../contracts/auth.ts";
import { signOutFailure } from "./auth.tsx";
import { useCommandBar } from "./command-bar-context.tsx";
import { accountItems, items, settings } from "./navigation-items.ts";
import { useOrganizationRoute, useSwitchOrganization } from "./organization.tsx";

/** An organization page a host adds to the common ones. */
export interface CommandBarItem {
  readonly label: string;
  readonly icon: IconSvgElement;
  readonly onSelect: () => void;
}

function useSignOutItem() {
  const signOut = useAtomSet(signOutAtom, { mode: "promiseExit" });
  return {
    id: "sign-out",
    label: "Sign out",
    keywords: "log out logout",
    icon: Logout01Icon,
    // The palette stays open until the exit is known, so a failure is shown where it was chosen.
    onSelect: async () => signOutFailure(await signOut()),
  };
}

function useAccountGroup(organizationSlug: string): CommandPaletteGroup {
  const navigate = useNavigate();
  const signOut = useSignOutItem();
  return {
    heading: "Account",
    items: [
      {
        id: "account-settings",
        label: "Account settings",
        keywords: "profile security tokens",
        icon: UserIcon,
        onSelect: () =>
          void navigate({ to: "/account/profile", search: { organization: organizationSlug } }),
      },
      signOut,
    ],
  };
}

/** The account area's own pages, which keep the organization the visitor came from. */
function AccountCommandBar({
  onOpenChange,
  restoreFocus,
}: {
  readonly onOpenChange: (open: boolean) => void;
  readonly restoreFocus: (event: Event) => void;
}) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const { organization } = parseAccountSearch(search);
  const signOut = useSignOutItem();
  const groups = useMemo(
    () =>
      [
        {
          heading: "Account",
          items: [
            ...accountItems.map((item) => ({
              id: `account-${item.to}`,
              label: item.label,
              icon: item.icon,
              hint: "Page",
              onSelect: () => void navigate({ to: item.to, search: { organization } }),
            })),
            ...(organization === undefined
              ? []
              : [
                  {
                    id: "return-to-organization",
                    label: "Back to organization",
                    keywords: "return home apps",
                    icon: ArrowLeft01Icon,
                    onSelect: () =>
                      void navigate({
                        to: "/org/$organizationSlug",
                        params: { organizationSlug: organization },
                      }),
                  },
                ]),
            signOut,
          ],
        },
      ] satisfies ReadonlyArray<CommandPaletteGroup>,
    [navigate, organization, signOut],
  );
  return (
    <CommandPalette
      open
      onOpenChange={onOpenChange}
      groups={groups}
      onCloseAutoFocus={restoreFocus}
    />
  );
}

function OrganizationCommandBar({
  organizationSlug,
  extra,
  onOpenChange,
  restoreFocus,
}: {
  readonly organizationSlug: string;
  readonly extra: ReadonlyArray<CommandBarItem>;
  readonly onOpenChange: (open: boolean) => void;
  readonly restoreFocus: (event: Event) => void;
}) {
  const route = useOrganizationRoute();
  const navigate = useNavigate();
  const switchOrganization = useSwitchOrganization();
  const organizations = useAtomValue(organizationsAtom);
  const account = useAccountGroup(organizationSlug);
  const inventoryResult = useAtomValue(resourceInventoryAtom(route.organization));
  const inventory = AsyncResult.value(inventoryResult);
  const groups = useMemo(() => {
    const common = [...items, settings].map((item) => ({
      id: `page-${item.to}`,
      label: item.label,
      icon: item.icon,
      hint: "Page",
      onSelect: () => void navigate({ to: item.to, params: { organizationSlug } }),
    }));
    const host = extra.map((item) => ({
      id: `page-${item.label}`,
      label: item.label,
      icon: item.icon,
      hint: "Page",
      onSelect: item.onSelect,
    }));
    const pages = [...common.slice(0, items.length), ...host, ...common.slice(items.length)];
    const apps = Option.isSome(inventory)
      ? inventory.value.apps.map((app) => ({
          id: `app-${app.id}`,
          label: app.name,
          keywords: "app",
          icon: BoxesIcon,
          hint: "App",
          onSelect: () =>
            void navigate({
              to: "/org/$organizationSlug/apps/$appId",
              params: { organizationSlug, appId: app.id },
            }),
        }))
      : [];
    const others = AsyncResult.isSuccess(organizations)
      ? organizations.value
          .filter((item) => item.slug !== organizationSlug)
          .map((item) => ({
            id: `organization-${item.id}`,
            label: `Switch to ${item.name}`,
            keywords: "organization team workspace",
            icon: Building03Icon,
            onSelect: () => void switchOrganization(item),
          }))
      : [];
    return [
      { heading: "Navigate", items: pages },
      {
        heading: "Apps",
        items: apps,
        // The inventory loads once the palette opens, so say so instead of showing nothing.
        status: Option.isSome(inventory)
          ? undefined
          : AsyncResult.isFailure(inventoryResult)
            ? "Apps could not be loaded."
            : "Loading apps…",
      },
      { heading: "Organizations", items: others },
      account,
    ] satisfies ReadonlyArray<CommandPaletteGroup>;
  }, [
    account,
    extra,
    inventory,
    inventoryResult,
    navigate,
    organizationSlug,
    organizations,
    switchOrganization,
  ]);
  return (
    <CommandPalette
      open
      onOpenChange={onOpenChange}
      groups={groups}
      onCloseAutoFocus={restoreFocus}
    />
  );
}

/**
 * The command palette. Its data is read only while it is open, and it lists pages, apps,
 * organizations and account actions; the pending dashboard frame offers only account actions.
 */
export function CommandBar({
  organizationSlug,
  extra = [],
}: {
  readonly organizationSlug: string | undefined;
  readonly extra?: ReadonlyArray<CommandBarItem> | undefined;
}) {
  const { open, setOpen, restoreFocus } = useCommandBar();
  if (!open) return null;
  return organizationSlug === undefined ? (
    <AccountCommandBar onOpenChange={setOpen} restoreFocus={restoreFocus} />
  ) : (
    <OrganizationCommandBar
      organizationSlug={organizationSlug}
      extra={extra}
      onOpenChange={setOpen}
      restoreFocus={restoreFocus}
    />
  );
}
