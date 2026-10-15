"use client";

import { useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/tooltip.tsx";

/** A message filling the drawer body. */
export function Notice({ children }: { readonly children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

/** The strip above a viewer's content. */
export function PreviewToolbar({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

export interface ViewOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** An icon replaces the visible label, which then names the button and its tooltip. */
  readonly icon?: React.ComponentProps<typeof HugeiconsIcon>["icon"];
}

/**
 * Choose one of a few views. A radiogroup is one tab stop; the arrow keys move the choice, as a
 * native radio group does.
 */
export function ViewSwitch<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly ViewOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  const onKey = (event: React.KeyboardEvent<HTMLButtonElement>, current: T) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === current);
    const next = options[(index + step + options.length) % options.length]!;
    onChange(next.value);
    group.current?.querySelectorAll("button")[options.indexOf(next)]?.focus();
  };
  return (
    <TooltipProvider>
      <div
        ref={group}
        role="radiogroup"
        aria-label={label}
        className="flex shrink-0 rounded-md border p-0.5"
      >
        {options.map((option) => {
          const button = (
            <button
              type="button"
              role="radio"
              aria-checked={value === option.value}
              tabIndex={value === option.value ? 0 : -1}
              onKeyDown={(event) => onKey(event, option.value)}
              aria-label={option.label}
              onClick={() => onChange(option.value)}
              className={`rounded px-2 py-1 text-xs transition-colors ${
                value === option.value
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {option.icon === undefined ? (
                option.label
              ) : (
                <HugeiconsIcon icon={option.icon} size={16} aria-hidden />
              )}
            </button>
          );
          if (option.icon === undefined) return <span key={option.value}>{button}</span>;
          return (
            <Tooltip key={option.value}>
              <TooltipTrigger asChild>{button}</TooltipTrigger>
              <TooltipContent>{option.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
