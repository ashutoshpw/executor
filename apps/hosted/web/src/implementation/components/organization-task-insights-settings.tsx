import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Exit, Option } from "effect";
import { useId, useState } from "react";
import { Button } from "@executor-js/ui/components/button";
import { Checkbox } from "@executor-js/ui/components/checkbox";
import { Input } from "@executor-js/ui/components/input";
import { Card, CardContent, CardFooter } from "@executor-js/ui/components/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/ui/components/select";
import type {
  TaskArgumentRetentionDays,
  TaskInsightsSettings,
} from "@executor-js/hosted-server/task-insights-settings";
import {
  saveTaskInsightsSettingsAtom,
  taskInsightsSettingsAtom,
} from "../../contracts/task-insights-settings.ts";
import { appError } from "../../contracts/errors.ts";
import { useOrganization } from "./organization.tsx";
import { HostedFailure } from "./dashboard-bindings.tsx";
import {
  organizationSettingClass,
  TaskInsightsHeading,
  TaskInsightsSettingsPending,
} from "./organization-settings-pending.tsx";

const retentionChoices = [7, 30, 90] as const satisfies readonly TaskArgumentRetentionDays[];
const actionClass =
  "organization-setting-action flex items-center gap-2.5 text-[12px] [&_>_button]:h-7.5 [&_>_button]:py-0 [&_>_button]:px-[12px] [&_>_button]:text-[12px] [&_>_button]:bg-transparent [&_>_button]:shadow-none max-[640px]:[&_>_button]:min-h-10";

/** Comma separated names, trimmed, empty entries dropped, repeats (in any case) removed. */
export const parseKeys = (text: string): readonly string[] => {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const part of text.split(",")) {
    const key = part.trim();
    if (key === "" || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    keys.push(key);
  }
  return keys;
};

/**
 * Whether tool call arguments are kept with task records, for how long, and which extra names are
 * masked. Only owners and admins can read it, so members see no card.
 */
export function OrganizationTaskInsightsSettings({ disabled }: { readonly disabled: boolean }) {
  const organization = useOrganization();
  const admin = organization.role !== "member";
  const result = useAtomValue(taskInsightsSettingsAtom(organization.organization));
  const refresh = useAtomRefresh(taskInsightsSettingsAtom(organization.organization));
  const settings = AsyncResult.value(result);
  if (!admin) return null;
  if (Option.isNone(settings))
    return AsyncResult.isFailure(result) ? (
      <Card className={organizationSettingClass}>
        <TaskInsightsHeading />
        <CardContent>
          <HostedFailure cause={result.cause} retry={refresh} />
        </CardContent>
      </Card>
    ) : (
      <TaskInsightsSettingsPending />
    );
  return (
    <TaskInsightsSettingsForm
      key={`${organization.organization}:${settings.value.recordArguments}:${settings.value.retentionDays}:${settings.value.extraMaskedKeys.join(",")}`}
      settings={settings.value}
      disabled={disabled}
    />
  );
}

function TaskInsightsSettingsForm({
  settings,
  disabled,
}: {
  readonly settings: TaskInsightsSettings;
  readonly disabled: boolean;
}) {
  const organization = useOrganization();
  const save = useAtomSet(saveTaskInsightsSettingsAtom(organization.organization), {
    mode: "promiseExit",
  });
  const state = useAtomValue(saveTaskInsightsSettingsAtom(organization.organization));
  const id = useId();
  const [record, setRecord] = useState(settings.recordArguments);
  const [retention, setRetention] = useState<TaskArgumentRetentionDays>(settings.retentionDays);
  const [keys, setKeys] = useState(settings.extraMaskedKeys.join(", "));
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const parsed = parseKeys(keys);
  const changed =
    record !== settings.recordArguments ||
    retention !== settings.retentionDays ||
    parsed.join("\n") !== settings.extraMaskedKeys.join("\n");
  const edited = () => {
    setSaved(false);
    setError(undefined);
  };
  return (
    <Card asChild className={organizationSettingClass}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (disabled || !changed) return;
          setError(undefined);
          setSaved(false);
          const result = await save({
            recordArguments: record,
            retentionDays: retention,
            extraMaskedKeys: parsed,
          });
          if (Exit.isFailure(result)) setError(appError(result.cause));
          else setSaved(true);
        }}
      >
        <TaskInsightsHeading />
        <CardContent>
          <div className="grid w-[min(100%,_520px)] gap-4">
            <div className="flex items-start gap-2.5">
              <Checkbox
                id={`${id}-record`}
                checked={record}
                disabled={disabled}
                aria-describedby={`${id}-record-hint`}
                onCheckedChange={(next) => {
                  setRecord(next === true);
                  edited();
                }}
              />
              <div className="grid gap-0.5">
                <label htmlFor={`${id}-record`} className="text-[13px] font-medium">
                  Record tool arguments
                </label>
                <p id={`${id}-record-hint`} className="text-[12px] text-muted-foreground">
                  Off by default. Credentials are masked before anything is stored.
                </p>
              </div>
            </div>
            <div className="grid gap-1.5">
              <label htmlFor={`${id}-retention`} className="text-[13px] font-medium">
                Keep arguments for
              </label>
              <Select
                value={String(retention)}
                disabled={disabled}
                onValueChange={(next) => {
                  const days = retentionChoices.find((choice) => String(choice) === next);
                  if (days === undefined) return;
                  setRetention(days);
                  edited();
                }}
              >
                <SelectTrigger id={`${id}-retention`} className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {retentionChoices.map((choice) => (
                    <SelectItem key={choice} value={String(choice)}>
                      {choice} days
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <label htmlFor={`${id}-keys`} className="text-[13px] font-medium">
                Extra names to mask
              </label>
              <Input
                id={`${id}-keys`}
                value={keys}
                placeholder="ssn, account_number"
                aria-describedby={`${id}-keys-hint`}
                disabled={disabled}
                onChange={(event) => {
                  setKeys(event.target.value);
                  edited();
                }}
              />
              <p id={`${id}-keys-hint`} className="text-[12px] text-muted-foreground">
                Comma separated. Values under these argument names are hidden, in any case.
              </p>
            </div>
          </div>
          {error && (
            <p role="alert" className="auth-error mt-3 text-destructive text-[13px]">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter>
          <p>
            {settings.available
              ? "Calls are always recorded; this setting only controls their arguments."
              : "This deployment keeps no tool call records, so nothing is recorded."}
          </p>
          <div className={actionClass}>
            {saved && <span role="status">Saved</span>}
            <Button variant="outline" loading={state.waiting} disabled={disabled || !changed}>
              Save
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}
