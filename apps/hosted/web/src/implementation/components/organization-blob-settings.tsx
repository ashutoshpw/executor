import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Exit, Option } from "effect";
import { useState } from "react";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { Card, CardContent, CardFooter } from "@executor-js/ui/components/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/ui/components/select";
import type { BlobSettings } from "@executor-js/hosted-server/blob-settings";
import { blobSettingsAtom, saveBlobSettingsAtom } from "../../contracts/blob-settings.ts";
import { appError } from "../../contracts/errors.ts";
import { useOrganization } from "./organization.tsx";
import { HostedFailure } from "./dashboard-bindings.tsx";
import {
  OrganizationBlobHeading,
  OrganizationBlobSettingsPending,
  organizationSettingClass,
} from "./organization-settings-pending.tsx";

const hour = 60 * 60;
const day = 24 * hour;
type Unit = "hours" | "days";
const unitSeconds = { hours: hour, days: day } as const;
const actionClass =
  "organization-setting-action flex items-center gap-2.5 text-[12px] [&_>_button]:h-7.5 [&_>_button]:py-0 [&_>_button]:px-[12px] [&_>_button]:text-[12px] [&_>_button]:bg-transparent [&_>_button]:shadow-none max-[640px]:[&_>_button]:min-h-10";

/** Whole days when the lifetime is one, otherwise hours, so a saved value reads back as entered. */
const display = (seconds: number): { readonly amount: number; readonly unit: Unit } =>
  seconds % day === 0
    ? { amount: seconds / day, unit: "days" }
    : { amount: Math.round(seconds / hour), unit: "hours" };

const hint = (settings: BlobSettings) =>
  `Between ${settings.minTtlSeconds / hour} hour and ${settings.maxTtlSeconds / day} days · default ${settings.defaultTtlSeconds / day} days`;

/** The organization's file lifetime, shown beside its other settings. */
export function OrganizationBlobSettings({ disabled }: { readonly disabled: boolean }) {
  const organization = useOrganization();
  const result = useAtomValue(blobSettingsAtom(organization.organization));
  const refresh = useAtomRefresh(blobSettingsAtom(organization.organization));
  const settings = AsyncResult.value(result);
  if (Option.isNone(settings))
    return AsyncResult.isFailure(result) ? (
      <Card className={organizationSettingClass}>
        <OrganizationBlobHeading />
        <CardContent>
          <HostedFailure cause={result.cause} retry={refresh} />
        </CardContent>
      </Card>
    ) : (
      <OrganizationBlobSettingsPending />
    );
  return (
    <BlobSettingsForm
      key={`${organization.organization}:${settings.value.ttlSeconds}`}
      settings={settings.value}
      disabled={disabled}
    />
  );
}

function BlobSettingsForm({
  settings,
  disabled,
}: {
  readonly settings: BlobSettings;
  readonly disabled: boolean;
}) {
  const organization = useOrganization();
  const save = useAtomSet(saveBlobSettingsAtom(organization.organization), {
    mode: "promiseExit",
  });
  const state = useAtomValue(saveBlobSettingsAtom(organization.organization));
  const initial = display(settings.ttlSeconds);
  const [amount, setAmount] = useState(String(initial.amount));
  const [unit, setUnit] = useState<Unit>(initial.unit);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const disabledReason = settings.canEdit
    ? undefined
    : "Only organization owners and admins can change organization settings.";
  const seconds = Number(amount) * unitSeconds[unit];
  const valid =
    Number.isInteger(seconds) &&
    seconds >= settings.minTtlSeconds &&
    seconds <= settings.maxTtlSeconds;
  return (
    <Card asChild className={organizationSettingClass}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (disabled || disabledReason !== undefined || !valid) return;
          setError(undefined);
          setSaved(false);
          const result = await save(seconds);
          if (Exit.isFailure(result)) setError(appError(result.cause));
          else setSaved(true);
        }}
      >
        <OrganizationBlobHeading />
        <CardContent>
          <div className="flex w-[min(100%,_520px)] items-center gap-2">
            <Input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              aria-label="File lifetime"
              aria-describedby="organization-blob-hint"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setSaved(false);
                setError(undefined);
              }}
              required
              disabled={disabled}
              disabledReason={disabledReason}
            />
            <Select
              value={unit}
              disabled={disabled || disabledReason !== undefined}
              onValueChange={(next) => {
                if (next !== "hours" && next !== "days") return;
                setUnit(next);
                setSaved(false);
                setError(undefined);
              }}
            >
              <SelectTrigger aria-label="File lifetime unit" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hours">Hours</SelectItem>
                <SelectItem value="days">Days</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error && (
            <p role="alert" className="auth-error mt-3 text-destructive text-[13px]">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter>
          <p id="organization-blob-hint">{hint(settings)}</p>
          <div className={actionClass}>
            {saved && <span role="status">Saved</span>}
            <Button
              variant="outline"
              loading={state.waiting}
              disabled={disabled || !valid || seconds === settings.ttlSeconds}
              disabledReason={disabledReason}
            >
              Save
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}
