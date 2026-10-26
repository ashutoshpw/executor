import {
  BoxesIcon,
  File01Icon,
  FingerPrintIcon,
  Home01Icon,
  Key01Icon,
  ConnectIcon,
  Settings05Icon,
  TaskDone01Icon,
  Shield01Icon,
  UserCircleIcon,
  UserGroupIcon,
  UserIcon,
} from "@hugeicons/core-free-icons";

/** The organization pages every hosted dashboard shows, in sidebar order. */
export const items = [
  { to: "/org/$organizationSlug", label: "Home", icon: Home01Icon, exact: true },
  { to: "/org/$organizationSlug/apps", label: "Apps", icon: BoxesIcon },
  { to: "/org/$organizationSlug/connect", label: "Connections", icon: ConnectIcon },
  { to: "/org/$organizationSlug/accounts", label: "Accounts", icon: UserCircleIcon },
  { to: "/org/$organizationSlug/approvals", label: "Approvals", icon: Shield01Icon },
  { to: "/org/$organizationSlug/files", label: "Files", icon: File01Icon },
  { to: "/org/$organizationSlug/groups", label: "Groups", icon: UserGroupIcon },
] as const;
/** Pages only owners and admins see: task records can include other people's work. */
export const adminItems = [
  { to: "/org/$organizationSlug/tasks", label: "Tasks", icon: TaskDone01Icon },
] as const;
/** The organization settings page, listed after the host's own pages. */
export const settings = {
  to: "/org/$organizationSlug/organization",
  label: "Settings",
  icon: Settings05Icon,
} as const;

/** Personal settings belong to the signed-in user, not to the organization in the URL. */
export const accountItems = [
  { to: "/account/profile", label: "Profile", icon: UserIcon },
  { to: "/account/security", label: "Security", icon: FingerPrintIcon },
  { to: "/account/tokens", label: "Tokens", icon: Key01Icon },
] as const;
