const prefix = "one-keyboard:v1:";

export function readStored(key, fallback = "") {
  try {
    return (
      localStorage.getItem(`${prefix}${key}`) ||
      localStorage.getItem(key) ||
      fallback
    );
  } catch {
    return fallback;
  }
}

export function writeStored(key, value) {
  try {
    const text = String(value);
    localStorage.setItem(`${prefix}${key}`, text);
    // Keep the original keys during the migration for existing tabs and links.
    localStorage.setItem(key, text);
  } catch {
    // Storage can be unavailable in private browsing; the app still works for this tab.
  }
}
