import { usePageUrl } from "@executor-js/dashboard-start/page";
import { OrganizationMembersPending } from "./organization-members.tsx";
import type { ReactNode } from "react";
import { Button } from "@executor-js/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@executor-js/ui/components/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@executor-js/ui/components/tabs";
import { useOrganizationRouteRole } from "./organization.tsx";
import type { OrganizationTab } from "../../contracts/navigation.ts";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { PageFrame, PageHeader } from "@executor-js/ui/dashboard/page";
import { organizationSlugMaxLength } from "@executor-js/hosted-server/organization";

/** Keep form geometry identical before and after the organization values arrive. */
export const organizationSettingClass =
  "organization-setting border border-border rounded-[10px] bg-background shadow-none flex flex-col gap-0 p-0 [&_[data-slot='card-header']]:gap-1 [&_[data-slot='card-header']]:[padding:14px_16px_10px] [&_[data-slot='card-title']_h2]:text-[14px] [&_[data-slot='card-title']_h2]:leading-[1.4] [&_[data-slot='card-title']_h2]:font-medium [&_[data-slot='card-description']]:text-[12px] [&_[data-slot='card-description']]:leading-[1.5] [&_[data-slot='card-content']]:min-w-0 [&_[data-slot='card-content']]:[padding:0_16px_10px] [&_[data-slot='card-footer']]:justify-between [&_[data-slot='card-footer']]:gap-3 [&_[data-slot='card-footer']]:[padding:0_16px_12px] [&_[data-slot='card-footer']]:border-0 [&_[data-slot='card-footer']_>_p]:text-muted-foreground [&_[data-slot='card-footer']_>_p]:text-[11px] max-[640px]:[&_[data-slot='card-header']]:[padding:12px_12px_10px] max-[640px]:[&_[data-slot='card-content']]:[padding:0_12px_12px] max-[640px]:[&_[data-slot='card-footer']]:[padding:0_12px_10px]";

/** Tabs shown for a role; Task insights are owner and admin only. */
export function organizationTabList(
  administrator: boolean,
  extraTabs: ReadonlyArray<{ readonly id: OrganizationTab; readonly label: string }>,
): ReadonlyArray<{ readonly id: OrganizationTab; readonly label: string }> {
  return [
    { id: "general", label: "General" },
    { id: "members", label: "Members" },
    { id: "files", label: "Files" },
    ...(administrator ? [{ id: "task-insights" as const, label: "Task insights" }] : []),
    ...extraTabs.map(({ id, label }) => ({ id, label })),
  ];
}

/** The tab list scrolls sideways on narrow screens; only the active tab's content is mounted. */
export function OrganizationTabs({
  tabs,
  active,
  onChange,
  content,
}: {
  readonly tabs: ReadonlyArray<{ readonly id: OrganizationTab; readonly label: string }>;
  readonly active: OrganizationTab;
  readonly onChange: (tab: OrganizationTab) => void;
  readonly content: (tab: OrganizationTab) => ReactNode;
}) {
  return (
    <Tabs
      value={active}
      onValueChange={(value) => {
        const next = tabs.find((item) => item.id === value);
        if (next) onChange(next.id);
      }}
      className="gap-4"
    >
      <div className="max-w-full overflow-x-auto">
        <TabsList variant="line" aria-label="Organization settings" className="mb-1">
          {tabs.map((item) => (
            <TabsTrigger key={item.id} value={item.id} className="flex-none px-3">
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value={active} className="organization-settings flex flex-col gap-3">
        {content(active)}
      </TabsContent>
    </Tabs>
  );
}

/** Render known settings copy and controls, with placeholders only for server values. */
export function OrganizationSettingsPending({
  tab,
  extraTabs = [],
}: {
  readonly tab?: OrganizationTab | undefined;
  readonly extraTabs?:
    | ReadonlyArray<{
        readonly id: OrganizationTab;
        readonly label: string;
        readonly content: ReactNode;
      }>
    | undefined;
}) {
  const page = usePageUrl();
  const role = useOrganizationRouteRole();
  const tabs = organizationTabList(role === "owner" || role === "admin", extraTabs);
  const active = tabs.find((item) => item.id === tab)?.id ?? "general";
  return (
    <PageFrame>
      <PageHeader
        title={<Skeleton className="h-[29.7px] w-44" aria-label="Loading organization name" />}
      />
      <OrganizationTabs
        tabs={tabs}
        active={active}
        onChange={() => {}}
        content={(id) => {
          switch (id) {
            case "general":
              return (
                <div role="status" aria-label="Loading organization settings" className="contents">
                  <Card className={organizationSettingClass}>
                    <CardHeader>
                      <CardTitle>
                        <h2>Organization name</h2>
                      </CardTitle>
                      <CardDescription>Shown across Executor.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="flex h-9 w-[min(100%,_520px)] items-center rounded-[6px] border border-input px-3 max-[740px]:min-h-11 max-[640px]:h-10">
                        <Skeleton className="h-3.5 w-36" aria-label="Loading name" />
                      </div>
                    </CardContent>
                    <CardFooter>
                      <p>Up to 120 characters</p>
                      <div className="flex items-center [&_>_button]:h-7.5 [&_>_button]:px-3 [&_>_button]:text-xs max-[640px]:[&_>_button]:min-h-10">
                        <Button variant="outline" disabled>
                          Save
                        </Button>
                      </div>
                    </CardFooter>
                  </Card>
                  <Card className="organization-setting gap-0 py-0">
                    <CardHeader className="gap-1.5 px-4 pt-4 pb-3">
                      <CardTitle>
                        <h2>Organization icon</h2>
                      </CardTitle>
                      <CardDescription>Shown in the organization menu.</CardDescription>
                    </CardHeader>
                    <CardContent className="px-4 pb-4">
                      <Skeleton
                        className="size-11 rounded-[10px]"
                        aria-label="Loading organization icon"
                      />
                    </CardContent>
                    <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
                      <p>PNG, JPG, or WebP · up to 2 MB</p>
                      <Button variant="outline" disabled>
                        Save
                      </Button>
                    </CardFooter>
                  </Card>
                  <Card className={organizationSettingClass}>
                    <CardHeader>
                      <CardTitle>
                        <h2>Organization URL</h2>
                      </CardTitle>
                      <CardDescription>
                        Changing this replaces your organization’s URL.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="flex w-[min(100%,_520px)] min-w-0 items-center overflow-hidden rounded-[6px] border border-input">
                        <span className="max-w-[50%] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap border-r border-input px-[10px] py-[7px] text-xs text-muted-foreground">
                          {page.host}/org/
                        </span>
                        <div className="flex h-8.5 min-w-0 flex-1 items-center px-3 max-[740px]:min-h-11 max-[640px]:h-9.5">
                          <Skeleton
                            className="h-3.5 w-24 max-w-full"
                            aria-label="Loading organization URL"
                          />
                        </div>
                      </div>
                    </CardContent>
                    <CardFooter>
                      <p>
                        Lowercase letters, numbers, hyphens · {organizationSlugMaxLength} characters
                        max
                      </p>
                      <div className="flex items-center [&_>_button]:h-7.5 [&_>_button]:px-3 [&_>_button]:text-xs max-[640px]:[&_>_button]:min-h-10">
                        <Button variant="outline" disabled>
                          Save
                        </Button>
                      </div>
                    </CardFooter>
                  </Card>
                  <span className="sr-only">Loading organization settings…</span>
                </div>
              );
            case "members":
              return <OrganizationMembersPending />;
            case "files":
              return <OrganizationBlobSettingsPending />;
            case "task-insights":
              return <TaskInsightsSettingsPending />;
            default:
              return extraTabs.find((item) => item.id === id)?.content;
          }
        }}
      />
    </PageFrame>
  );
}

/** The Blob card's heading, shared by the loaded card and its placeholder so neither moves. */
export function OrganizationBlobHeading() {
  return (
    <CardHeader>
      <CardTitle>
        <h2>Blob</h2>
      </CardTitle>
      <CardDescription>
        How long files that apps store for this organization are kept. Expired files are deleted.
      </CardDescription>
    </CardHeader>
  );
}

/** The Blob card's known copy and controls, with a placeholder only for the stored value. */
export function OrganizationBlobSettingsPending() {
  return (
    <Card className={organizationSettingClass}>
      <OrganizationBlobHeading />
      <CardContent>
        <div className="flex h-9 w-[min(100%,_520px)] items-center rounded-[6px] border border-input px-3 max-[740px]:min-h-11 max-[640px]:h-10">
          <Skeleton className="h-3.5 w-16" aria-label="Loading file lifetime" />
        </div>
      </CardContent>
      <CardFooter>
        <p>Between 1 hour and 365 days · default 7 days</p>
        <div className="flex items-center [&_>_button]:h-7.5 [&_>_button]:px-3 [&_>_button]:text-xs max-[640px]:[&_>_button]:min-h-10">
          <Button variant="outline" disabled>
            Save
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

/** The Task insights card's heading, shared by the loaded card and its placeholder. */
export function TaskInsightsHeading() {
  return (
    <CardHeader>
      <CardTitle>
        <h2>Task insights</h2>
      </CardTitle>
      <CardDescription>
        Whether the arguments of agents&apos; tool calls are kept with each task, and for how long.
      </CardDescription>
    </CardHeader>
  );
}

/** The Task insights card's known copy and controls, with placeholders for the stored values. */
export function TaskInsightsSettingsPending() {
  return (
    <Card className={organizationSettingClass}>
      <TaskInsightsHeading />
      <CardContent>
        <div className="grid w-[min(100%,_520px)] gap-4">
          <Skeleton className="h-4 w-44" aria-label="Loading task insights" />
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-9 w-full" />
        </div>
      </CardContent>
      <CardFooter>
        <p>Calls are always recorded; this setting only controls their arguments.</p>
        <div className="flex items-center [&_>_button]:h-7.5 [&_>_button]:px-3 [&_>_button]:text-xs max-[640px]:[&_>_button]:min-h-10">
          <Button variant="outline" disabled>
            Save
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
