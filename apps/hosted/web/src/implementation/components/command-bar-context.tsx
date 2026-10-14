import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon } from "@hugeicons/core-free-icons";

const CommandBarContext = createContext<{
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  /** Takes focus back to the element that had it when the bar opened. */
  readonly restoreFocus: (event: Event) => void;
} | null>(null);

export function useCommandBar() {
  const value = useContext(CommandBarContext);
  if (value === null) throw new Error("Command bar context is missing");
  return value;
}

/** Whether the keyboard event comes from an editor that owns Ctrl/Cmd+K itself. */
function inEditor(target: EventTarget | null) {
  return (
    target instanceof Element && target.closest(".cm-editor, [contenteditable='true']") !== null
  );
}

/**
 * Holds the open state and listens for Ctrl+K / Cmd+K anywhere in the signed-in dashboard. It sits
 * above the pages, so an open palette survives the pending dashboard frame becoming the resolved one.
 */
function OwnCommandBarProvider({ children }: { readonly children: ReactNode }) {
  const [open, setOpenState] = useState(false);
  const openRef = useRef(false);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const opener = useRef<Element | null>(null);
  const setOpen = useCallback((next: boolean) => {
    if (next) opener.current = document.activeElement;
    setOpenState(next);
  }, []);
  const restoreFocus = useCallback((event: Event) => {
    // The palette unmounts when closed, so return focus explicitly.
    event.preventDefault();
    // On a phone the trigger lives in the Menu sheet, which closes when it is used; the Menu button
    // is where the visitor was.
    const target =
      opener.current instanceof HTMLElement && opener.current.isConnected
        ? opener.current
        : document.querySelector<HTMLElement>("[data-shell-menu-trigger]");
    target?.focus();
  }, []);
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      if (inEditor(event.target)) return;
      event.preventDefault();
      setOpen(!openRef.current);
    };
    window.addEventListener("keydown", listen);
    return () => window.removeEventListener("keydown", listen);
  }, [setOpen]);
  const value = useMemo(() => ({ open, setOpen, restoreFocus }), [open, setOpen, restoreFocus]);
  return <CommandBarContext.Provider value={value}>{children}</CommandBarContext.Provider>;
}

/** Provides the command bar once; a frame inside an existing provider shares the outer one. */
export function CommandBarProvider({ children }: { readonly children: ReactNode }) {
  const outer = useContext(CommandBarContext);
  return outer === null ? <OwnCommandBarProvider>{children}</OwnCommandBarProvider> : children;
}

/** The sidebar search button; it shows the platform's shortcut once the browser is known. */
export function CommandBarTrigger() {
  const { setOpen } = useCommandBar();
  // The server render and hydration show the generic hint; the browser's own follows.
  const mac = useSyncExternalStore(
    () => () => {},
    () => /mac|iphone|ipad/i.test(navigator.platform),
    () => false,
  );
  return (
    <button
      type="button"
      data-close-menu
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K"
      title="Search"
      onClick={() => setOpen(true)}
      className="command-bar-trigger flex min-h-9 w-full items-center gap-2 rounded-[6px] border border-border px-2 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground max-[740px]:min-h-11"
    >
      <HugeiconsIcon icon={Search01Icon} strokeWidth={2} size={16} aria-hidden />
      <span className="flex-1 text-left">Search</span>
      <span aria-hidden className="rounded bg-muted px-1 font-mono text-[11px]">
        <kbd className="font-sans">{mac ? "⌘K" : "Ctrl K"}</kbd>
      </span>
    </button>
  );
}
