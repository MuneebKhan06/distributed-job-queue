import { useEffect, useState } from "react";

export interface HashRoute {
  path: string;
  params: URLSearchParams;
}

// replaceState does not fire hashchange, so replaceHash announces itself with
// this event instead.
const REPLACED = "hashreplace";

function currentRoute(): HashRoute {
  const hash = window.location.hash.replace(/^#/, "") || "/";
  const [path, query = ""] = hash.split("?", 2);
  return { path: path || "/", params: new URLSearchParams(query) };
}

function buildHash(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      query.set(key, value);
    }
  }
  const search = query.toString();
  return `#${path}${search ? `?${search}` : ""}`;
}

/**
 * Swap the current hash without adding a history entry.
 *
 * Used for filter edits, where a back button that steps through every
 * keystroke would be worse than useless.
 */
export function replaceHash(path: string, params: Record<string, string | undefined>): void {
  const next = buildHash(path, params);
  if (next !== window.location.hash) {
    window.history.replaceState(null, "", next);
    window.dispatchEvent(new Event(REPLACED));
  }
}

/** Like replaceHash, but leaves a history entry so Back returns here. */
export function pushHash(path: string, params: Record<string, string | undefined>): void {
  window.location.hash = buildHash(path, params);
}

/**
 * The current hash path and its query, kept in sync with the address bar.
 *
 * Hash routing means the built dashboard can be served as plain static files
 * by anything, with no server side rewrite rule for deep links.
 */
export function useHashRoute(): HashRoute {
  const [route, setRoute] = useState(currentRoute);

  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onChange);
    window.addEventListener(REPLACED, onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener(REPLACED, onChange);
    };
  }, []);

  return route;
}
