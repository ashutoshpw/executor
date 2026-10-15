"use client";

import * as React from "react";
import { cn } from "../lib/utils.ts";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Button } from "./button.tsx";

const MIN_PERCENT = 30;
const MAX_PERCENT = 95;
const MIN_PIXELS = 360;
const DEFAULT_PIXELS = 720;
const KEYBOARD_STEP_PERCENT = 5;
/** Below this viewport width the sheet stays full width and cannot be resized. */
const RESIZE_MIN_VIEWPORT = 640;

function readStoredPercent(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    // Storage can be blocked (private mode, site data cleared); fall back to the default.
    return null;
  }
}

function writeStoredPercent(key: string, value: number | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(value));
  } catch {
    // Storage is unavailable; the width simply is not remembered.
  }
}

function percentBounds(viewport: number) {
  const min = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, (MIN_PIXELS / viewport) * 100));
  return { min, max: MAX_PERCENT };
}

function clampPercent(value: number, viewport: number) {
  const { min, max } = percentBounds(viewport);
  return Math.min(max, Math.max(min, value));
}

function defaultPercent(viewport: number) {
  return clampPercent((Math.min(DEFAULT_PIXELS, viewport) / viewport) * 100, viewport);
}

/** Width of a resizable sheet as a percentage of the viewport, remembered in localStorage. */
function useResizableWidth(storageKey: string | undefined, enabled: boolean) {
  const [viewport, setViewport] = React.useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const [stored, setStored] = React.useState<number | null>(() =>
    enabled && storageKey && typeof window !== "undefined" ? readStoredPercent(storageKey) : null,
  );
  const storedRef = React.useRef(stored);

  React.useEffect(() => {
    if (!enabled) return;
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [enabled]);

  const active = enabled && viewport >= RESIZE_MIN_VIEWPORT;
  const percent = clampPercent(stored ?? defaultPercent(viewport), viewport);
  const bounds = percentBounds(viewport);

  const preview = (value: number) => {
    const next = clampPercent(value, window.innerWidth);
    storedRef.current = next;
    setStored(next);
  };
  const commit = () => {
    if (storageKey && storedRef.current !== null) writeStoredPercent(storageKey, storedRef.current);
  };
  const reset = () => {
    storedRef.current = null;
    setStored(null);
    if (storageKey) writeStoredPercent(storageKey, null);
  };

  return { active, percent, bounds, viewport, preview, commit, reset };
}

function SheetResizeHandle({ resize }: { resize: ReturnType<typeof useResizableWidth> }) {
  const dragging = React.useRef(false);
  const previousUserSelect = React.useRef("");

  const stopDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.userSelect = previousUserSelect.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resize.commit();
  };

  // Restore text selection if the sheet unmounts mid-drag.
  React.useEffect(
    () => () => {
      if (dragging.current) document.body.style.userSelect = previousUserSelect.current;
    },
    [],
  );

  const { percent, bounds } = resize;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize preview"
      aria-valuemin={Math.round(bounds.min)}
      aria-valuemax={Math.round(bounds.max)}
      aria-valuenow={Math.round(percent)}
      tabIndex={0}
      data-slot="sheet-resize-handle"
      className="group absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none outline-none select-none"
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        dragging.current = true;
        previousUserSelect.current = document.body.style.userSelect;
        document.body.style.userSelect = "none";
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const viewport = window.innerWidth;
        resize.preview(((viewport - event.clientX) / viewport) * 100);
      }}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      onDoubleClick={resize.reset}
      onKeyDown={(event) => {
        let next: number | null = null;
        if (event.key === "ArrowLeft") next = percent + KEYBOARD_STEP_PERCENT;
        else if (event.key === "ArrowRight") next = percent - KEYBOARD_STEP_PERCENT;
        else if (event.key === "Home") next = bounds.min;
        else if (event.key === "End") next = bounds.max;
        else if (event.key === "Enter") {
          event.preventDefault();
          resize.reset();
          return;
        }
        if (next === null) return;
        event.preventDefault();
        resize.preview(next);
        resize.commit();
      }}
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-ring group-focus-visible:w-0.5 group-focus-visible:bg-ring" />
    </div>
  );
}

/** Sheet root: a modal panel docked to the right edge, on the Dialog primitive. */
function Sheet({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />;
}

/** Sheet content: full height, slides in from the right, traps focus and closes on Esc. */
function SheetContent({
  className,
  children,
  style,
  resizable = false,
  storageKey,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** Show a drag handle on the left edge; the width is kept as a percentage of the viewport. */
  resizable?: boolean;
  /** localStorage key that remembers the resized width across openings. */
  storageKey?: string;
}) {
  const resize = useResizableWidth(storageKey, resizable);
  const resized = resizable && resize.active;
  return (
    <DialogPrimitive.Portal data-slot="sheet-portal">
      <DialogPrimitive.Overlay
        data-slot="sheet-overlay"
        className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
      />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex h-full w-[min(720px,100vw)] flex-col border-l bg-popover text-popover-foreground shadow-lg outline-none duration-300 data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:animate-in data-[state=open]:slide-in-from-right",
          className,
        )}
        style={resized ? { ...style, width: `${resize.percent}vw` } : style}
        {...props}
      >
        {resized ? <SheetResizeHandle resize={resize} /> : null}
        {children}
        <DialogPrimitive.Close asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-3 right-3 text-muted-foreground"
            aria-label="Close"
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden />
          </Button>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** Sheet header: the title area, leaving room for the close button. */
function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1 border-b p-4 pr-14", className)}
      {...props}
    />
  );
}

/** Sheet title primitive. */
function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-base leading-none font-semibold", className)}
      {...props}
    />
  );
}

/** Sheet description primitive. */
function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle };
