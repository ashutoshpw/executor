import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { Label } from "@executor-js/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/ui/components/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@executor-js/ui/components/card";
import { accountSettingClass } from "@executor-js/hosted-web/account";
import { AuthFailed } from "@executor-js/hosted-web/contracts/auth";
import {
  instanceOwnerAtom,
  transferCandidatesAtom,
  transferOwnershipAtom,
} from "../../contracts/auth.ts";

const inputClass =
  "w-[min(100%,_520px)] h-9 rounded-[6px] bg-transparent shadow-none max-[640px]:h-10 max-[640px]:text-[16px]";

const transferError = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  if (!(error instanceof AuthFailed)) return "Unable to transfer the instance. Try again.";
  if (error.status === 400) return "Choose someone who owns or administers an organization.";
  if (error.status === 403) return "Only the instance owner can transfer it.";
  return error.message;
};

/**
 * Who owns the instance: only the owner sees this, and may hand it to an owner or administrator
 * of any organization. Typing their email confirms it; the server checks the owner again.
 */
export function InstanceOwnership() {
  const owner = Option.getOrElse(AsyncResult.value(useAtomValue(instanceOwnerAtom)), () => false);
  // The card outlives the transfer, which ends this person's ownership, to say it happened.
  const [transferred, setTransferred] = useState<string>();
  if (!owner && transferred === undefined) return null;
  return <TransferOwnership transferred={transferred} onTransferred={setTransferred} />;
}

/** Read apart from the owner check, so people who are not the owner never ask for candidates. */
function TransferOwnership({
  transferred,
  onTransferred,
}: {
  readonly transferred: string | undefined;
  readonly onTransferred: (email: string) => void;
}) {
  const candidates = Option.getOrElse(
    AsyncResult.value(useAtomValue(transferCandidatesAtom)),
    () => [],
  );
  const transfer = useAtomSet(transferOwnershipAtom, { mode: "promiseExit" });
  const state = useAtomValue(transferOwnershipAtom);
  const [selected, setSelected] = useState<string>();
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string>();
  const target = candidates.find((candidate) => candidate.id === selected);
  const ready =
    target !== undefined && confirmation.trim().toLowerCase() === target.email.toLowerCase();
  return (
    <Card asChild className={accountSettingClass}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!ready || target === undefined) return;
          setError(undefined);
          const result = await transfer(target.id);
          if (Exit.isFailure(result)) setError(transferError(result.cause));
          else onTransferred(target.email);
        }}
      >
        <CardHeader>
          <CardTitle>
            <h2>Instance</h2>
          </CardTitle>
          <CardDescription>
            The instance owner creates organizations. Transfer ownership to an owner or
            administrator of an organization.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {transferred === undefined ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-instance-owner" className="text-[12px]">
                  New owner
                </Label>
                <Select
                  {...(selected === undefined ? {} : { value: selected })}
                  onValueChange={(value) => {
                    setSelected(value);
                    setConfirmation("");
                    setError(undefined);
                  }}
                  disabled={candidates.length === 0}
                >
                  <SelectTrigger
                    id="new-instance-owner"
                    aria-label="New owner"
                    className="w-[min(100%,_520px)]"
                  >
                    <SelectValue
                      placeholder={
                        candidates.length === 0
                          ? "No other owners or administrators"
                          : "Choose a person"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((candidate) => (
                      <SelectItem
                        key={candidate.id}
                        value={candidate.id}
                        textValue={`${candidate.name} ${candidate.email}`}
                      >
                        <span className="truncate">
                          {candidate.name} ({candidate.email})
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {target !== undefined && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="confirm-instance-owner" className="text-[12px]">
                    Type {target.email} to confirm
                  </Label>
                  <Input
                    id="confirm-instance-owner"
                    className={inputClass}
                    value={confirmation}
                    autoComplete="off"
                    onChange={(event) => {
                      setConfirmation(event.target.value);
                      setError(undefined);
                    }}
                  />
                </div>
              )}
            </>
          ) : (
            <p role="status" className="text-[13px]">
              {transferred} now owns this instance. You can no longer create organizations.
            </p>
          )}
          {error && (
            <p role="alert" className="auth-error text-destructive text-[13px]">
              {error}
            </p>
          )}
        </CardContent>
        {transferred === undefined && (
          <CardFooter>
            <p>You lose the right to create organizations.</p>
            <div className="flex items-center gap-2.5 text-[12px] [&_>_button]:h-7.5 [&_>_button]:py-0 [&_>_button]:px-[12px] [&_>_button]:text-[12px] [&_>_button]:bg-transparent [&_>_button]:shadow-none max-[640px]:[&_>_button]:min-h-10">
              <Button variant="outline" loading={state.waiting} disabled={!ready}>
                Transfer ownership
              </Button>
            </div>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}
