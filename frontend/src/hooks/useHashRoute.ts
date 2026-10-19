import { useEffect, useState } from "react";

function currentPath(): string {
  return window.location.hash.replace(/^#/, "") || "/";
}

/**
 * The current hash path, kept in sync with the address bar.
 *
 * Hash routing means the built dashboard can be served as plain static files
 * by anything, with no server side rewrite rule for deep links.
 */
export function useHashRoute(): string {
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return path;
}
