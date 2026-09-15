export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "inma-erp-theme";
export const THEME_CHANGE_EVENT = "inma-erp-theme-change";

// Runs in <head> before paint so the right theme never flashes wrong.
// An explicit choice (saved by setTheme below) always wins; absent
// that, follow the OS/browser preference instead of hardcoding light.
// Only these two fixed values can reach the document attribute.
export const themeInitScript = `(() => {
  try {
    const saved = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = saved === "dark" || (saved !== "light" && prefersDark) ? "dark" : "light";
  } catch {}
})();`;

// The global color/background/border transition (globals.css) fires on
// every element at once when data-theme flips, since they all read the
// same custom properties -- a full-page repaint animated over 120ms,
// which is slow and janky on any page with a large table. Briefly
// disabling transitions (see the .theme-switching rule) makes the
// switch instant without touching normal hover transitions.
function applyThemeInstantly(theme: Theme) {
  const root = document.documentElement;
  root.classList.add("theme-switching");
  root.dataset.theme = theme;
  // Force a synchronous reflow so the class above is in effect for
  // this change before the browser would otherwise start transitioning.
  void root.offsetHeight;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      root.classList.remove("theme-switching");
    });
  });
}

export function setTheme(theme: Theme) {
  applyThemeInstantly(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme switching still works when browser storage is unavailable.
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function getServerTheme(): Theme {
  return "light";
}

export function subscribeToTheme(onChange: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    applyThemeInstantly(event.newValue === "dark" ? "dark" : "light");
    onChange();
  }

  // Keep following the OS theme live as long as the user hasn't made
  // an explicit choice (setTheme) -- once they have, that choice wins
  // and this listener becomes a no-op for them.
  function onSystemChange(event: MediaQueryListEvent) {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      // Treat a storage read failure the same as "no explicit choice".
    }
    if (saved === "light" || saved === "dark") return;
    applyThemeInstantly(event.matches ? "dark" : "light");
    onChange();
  }

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  media.addEventListener("change", onSystemChange);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
    media.removeEventListener("change", onSystemChange);
  };
}
