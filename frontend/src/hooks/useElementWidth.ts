import { useEffect, useState } from "react";

/**
 * The rendered width of an element, kept current as the layout changes.
 *
 * Takes a callback ref rather than a ref object, because the element may only
 * mount after data arrives. An effect reading ref.current on first render
 * would find nothing and never look again.
 */
export function useElementWidth<T extends HTMLElement>(fallback: number) {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return { ref: setElement, width };
}
