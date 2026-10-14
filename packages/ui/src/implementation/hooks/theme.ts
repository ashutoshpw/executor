/** The light, dark or system theme choice, kept per browser. */
import { useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";

export const themeStorageKey = "executor:theme";
const changeEvent = "executor:theme-change";

const parse = (value: string | null): ThemePreference =>
  value === "light" || value === "dark" ? value : "system";

/**
 * Runs in the document head before first paint, so server-rendered pages never flash the wrong
 * theme. It sets `dark` or `light` on `<html>` and keeps following the OS while the choice is
 * System. The browser-only `applyTheme` below does the same work after hydration.
 * A `script-src` policy or nonce would need `router.options.ssr?.nonce` on this script's tag.
 */
export const themeScript = `(() => {
  const root = document.documentElement;
  const media = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    let preference = "system";
    try {
      preference = localStorage.getItem(${JSON.stringify(themeStorageKey)}) || "system";
    } catch {
      // Blocked storage: use the choice kept in memory for this page.
      preference = window.__executorTheme || "system";
    }
    const dark = preference === "dark" || (preference !== "light" && media.matches);
    root.classList.toggle("dark", dark);
    root.classList.toggle("light", !dark);
    root.style.colorScheme = dark ? "dark" : "light";
    root.dataset.themePreference = preference === "dark" || preference === "light" ? preference : "system";
  };
  apply();
  media.addEventListener("change", apply);
  addEventListener(${JSON.stringify(changeEvent)}, apply);
  // A choice made in another tab.
  addEventListener("storage", (event) => {
    if (event.key === null || event.key === ${JSON.stringify(themeStorageKey)}) apply();
  });
})();`;

/** The choice kept in memory on `window` when storage is blocked, so the head script sees it too. */
const keepInMemory = (preference: ThemePreference) => {
  Object.assign(window, { __executorTheme: preference });
};
const readMemory = (): ThemePreference => parse(Reflect.get(window, "__executorTheme") ?? null);

const read = (): ThemePreference => {
  try {
    return parse(localStorage.getItem(themeStorageKey));
  } catch {
    return readMemory();
  }
};

const subscribe = (notify: () => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === themeStorageKey) notify();
  };
  addEventListener("storage", onStorage);
  addEventListener(changeEvent, notify);
  return () => {
    removeEventListener("storage", onStorage);
    removeEventListener(changeEvent, notify);
  };
};

const write = (preference: ThemePreference) => {
  try {
    if (preference === "system") localStorage.removeItem(themeStorageKey);
    else localStorage.setItem(themeStorageKey, preference);
  } catch {
    // Storage can be blocked; the choice then lasts only until the page reloads.
    keepInMemory(preference);
  }
  // The pre-paint script's listener applies the choice to the document.
  dispatchEvent(new Event(changeEvent));
};

/** The saved choice and a setter. Server renders and hydration see System. */
export function useTheme(): readonly [ThemePreference, (preference: ThemePreference) => void] {
  const preference = useSyncExternalStore(subscribe, read, () => "system" as const);
  return [preference, write];
}
