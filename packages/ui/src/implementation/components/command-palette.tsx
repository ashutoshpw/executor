"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog.tsx";

/** One runnable entry of the command palette. */
export interface CommandPaletteItem {
  readonly id: string;
  readonly label: string;
  /** Extra words that also match the query, such as the destination's section. */
  readonly keywords?: string;
  readonly icon?: IconSvgElement;
  /** Right-aligned secondary text. */
  readonly hint?: string;
  /**
   * Runs the command. One that can fail returns a promise of the message to show: the palette stays
   * open and ignores further selections until it settles, and closes only when there is no message.
   */
  // oxlint-disable-next-line typescript/no-invalid-void-type -- most commands are synchronous and return nothing
  readonly onSelect: () => void | Promise<string | undefined>;
}

export interface CommandPaletteGroup {
  readonly heading: string;
  readonly items: ReadonlyArray<CommandPaletteItem>;
  /** Shown in the group's place while it has no items, such as "Loading apps…". */
  readonly status?: string | undefined;
}

/**
 * Scores how well a query matches a text; a lower number is a better match and `null` is none.
 * Substrings beat scattered letters, and earlier substrings beat later ones.
 */
export function matchScore(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;
  const haystack = text.toLowerCase();
  const index = haystack.indexOf(needle);
  if (index >= 0) return index;
  let position = 0;
  let spread = 0;
  for (const character of needle) {
    if (character === " ") continue;
    const next = haystack.indexOf(character, position);
    if (next < 0) return null;
    spread += next - position;
    position = next + 1;
  }
  return 1000 + spread;
}

/** Filters and orders each group by match quality, dropping groups with no match. */
function filterGroups(groups: ReadonlyArray<CommandPaletteGroup>, query: string) {
  return groups
    .map((group) => ({
      heading: group.heading,
      status: group.status,
      items: group.items
        .flatMap((item, order) => {
          const score = matchScore(query, `${item.label} ${item.keywords ?? ""}`);
          return score === null ? [] : [{ item, order, score }];
        })
        .sort((a, b) => a.score - b.score || a.order - b.order)
        .map((entry) => entry.item),
    }))
    .filter((group) => group.items.length > 0 || group.status !== undefined);
}

/**
 * A searchable list of commands in a dialog. The caller owns what the commands do; selecting one
 * runs it and closes the palette.
 */
export function CommandPalette({
  open,
  onOpenChange,
  groups,
  placeholder = "Type a command or search…",
  title = "Command bar",
  footer,
  onCloseAutoFocus,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly placeholder?: string;
  readonly title?: string;
  readonly footer?: ReactNode;
  /** Where focus goes on close; by default the element focused before the palette opened. */
  readonly onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={onCloseAutoFocus}
        className="command-palette top-[12%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[560px] max-[640px]:top-[8%]"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          Search pages, apps and actions. Use the arrow keys to choose and Enter to open.
        </DialogDescription>
        {/* Mounted only while open, so the query and selection start fresh every time. */}
        <PaletteBody
          groups={groups}
          placeholder={placeholder}
          title={title}
          close={() => onOpenChange(false)}
        />
        {footer}
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody({
  groups,
  placeholder,
  title,
  close,
}: {
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly placeholder: string;
  readonly title: string;
  readonly close: () => void;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => filterGroups(groups, query), [groups, query]);
  const flat = useMemo(() => visible.flatMap((group) => group.items), [visible]);
  const optionId = (item: CommandPaletteItem) => `${id}-option-${item.id}`;
  const current = flat[Math.min(active, flat.length - 1)];

  useEffect(() => {
    if (!current) return;
    // The scroll container is the listbox; keep the active row within it.
    listRef.current?.querySelector("[data-active=true]")?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const run = (item: CommandPaletteItem) => {
    if (pending) return;
    setFailure(undefined);
    const outcome = item.onSelect();
    if (outcome === undefined) {
      close();
      return;
    }
    setPending(true);
    void outcome.then((message) => {
      setPending(false);
      if (message === undefined) close();
      else setFailure(message);
    });
  };
  const move = (next: number) => {
    if (flat.length === 0) return;
    setActive((next + flat.length) % flat.length);
  };
  const activeIndex = current ? flat.indexOf(current) : 0;

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-3">
        <HugeiconsIcon
          icon={Search01Icon}
          strokeWidth={2}
          size={16}
          aria-hidden
          className="shrink-0 text-muted-foreground"
        />
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current ? optionId(current) : undefined}
          aria-busy={pending}
          aria-label={title}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setFailure(undefined);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(activeIndex + 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(activeIndex - 1);
            } else if (event.key === "Home") {
              event.preventDefault();
              move(0);
            } else if (event.key === "End") {
              event.preventDefault();
              move(flat.length - 1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (current) run(current);
            }
          }}
          className="h-12 min-w-0 flex-1 bg-transparent text-[16px] text-foreground outline-none placeholder:text-muted-foreground sm:text-[14px]"
        />
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={title}
        className="max-h-[min(380px,60dvh)] overflow-y-auto overscroll-contain p-1.5"
      >
        {visible.map((group, index) => (
          <div key={group.heading} role="group" aria-labelledby={`${id}-heading-${index}`}>
            <div
              id={`${id}-heading-${index}`}
              role="presentation"
              className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground"
            >
              {group.heading}
            </div>
            {group.items.length === 0 && group.status !== undefined && (
              <p role="status" className="px-2 py-2 text-[13px] text-muted-foreground">
                {group.status}
              </p>
            )}
            {group.items.map((item) => (
              <div
                key={item.id}
                id={optionId(item)}
                role="option"
                aria-selected={item === current}
                data-active={item === current}
                onMouseMove={() => setActive(flat.indexOf(item))}
                onClick={() => run(item)}
                className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-2 text-[13px] text-foreground data-[active=true]:bg-accent sm:min-h-9"
              >
                {item.icon && (
                  <HugeiconsIcon
                    icon={item.icon}
                    strokeWidth={2}
                    size={16}
                    aria-hidden
                    className="shrink-0 text-muted-foreground"
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">{item.hint}</span>
                )}
              </div>
            ))}
          </div>
        ))}
        {visible.length === 0 && (
          <p role="status" className="px-3 py-8 text-center text-[13px] text-muted-foreground">
            No results
          </p>
        )}
      </div>
      {failure !== undefined && (
        <p role="alert" className="border-t border-border px-3 py-2 text-[13px] text-destructive">
          {failure}
        </p>
      )}
    </>
  );
}
