import { useEffect, useRef } from "react";

const FLASH_INTERVAL_MS = 1000;

/*
==================================================
useFlashingTitle
==================================================
Per explicit request — a way to get the agent's attention when an
incoming call is ringing and this tab is minimized, backgrounded, or
buried behind other tabs. Modern browsers deliberately block a page
from forcing itself to the front (window.focus() from a background
tab is silently ignored/restricted for exactly this reason — letting
pages steal focus at will would be a real abuse vector), so this
can't literally "pop up" the window. What IS reliably possible: make
the tab itself visually unmissable by alternating its title, which
shows up in the taskbar/tab strip regardless of what's currently in
front.

shouldFlash: boolean — flashing starts the instant this becomes true,
stops (and the original title is restored) the instant it becomes
false. Callers pass something like
inboundCall?.status === "ringing_agent" — this hook has no opinion on
WHEN to flash, only HOW.

flashText: what to alternate with the page's actual title.
*/
export function useFlashingTitle(shouldFlash, flashText = "📞 Incoming Call!") {
  const originalTitleRef = useRef(document.title);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!shouldFlash) {
      clearInterval(intervalRef.current);
      document.title = originalTitleRef.current;
      return;
    }

    // Capture whatever the title actually is right NOW, not whatever
    // it happened to be on first mount — covers the (currently
    // theoretical, since nothing else in this app touches
    // document.title) case where it changed for some other reason
    // between mount and this specific flash starting.
    originalTitleRef.current = document.title;

    let showingFlash = false;
    intervalRef.current = setInterval(() => {
      showingFlash = !showingFlash;
      document.title = showingFlash ? flashText : originalTitleRef.current;
    }, FLASH_INTERVAL_MS);

    return () => {
      clearInterval(intervalRef.current);
      document.title = originalTitleRef.current;
    };
  }, [shouldFlash, flashText]);
}
