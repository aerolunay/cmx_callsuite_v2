import { useCallback, useSyncExternalStore } from "react";

/*
==================================================
useMediaQuery
==================================================
true while the CSS media query matches, updating live as the window is
resized. Per explicit request — agents shrink the Dialer window to make
room for other tools, and DialerPage switches to a compact layout
(COMPACT_DIALER_QUERY) when they do. Kept in step with the matching
@media rule in theme.css so JS-driven and CSS-driven parts of the
layout switch at exactly the same width.
==================================================
*/
export const COMPACT_DIALER_QUERY = "(max-width: 899px)";

export function useMediaQuery(query) {
  const subscribe = useCallback(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query]
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}
