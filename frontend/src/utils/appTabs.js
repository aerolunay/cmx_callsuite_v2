/*
==================================================
Separate Dialer tab — per explicit request
==================================================
Roles with Dialer access other than plain agents (supervisor,
training_quality) always get the Dialer in its OWN browser tab, so it
stays up while they use Live Status / Reports / Recordings in the main
tab. Plain agents are unaffected — the Dialer is their only page.

Tabs are found again by window name, so clicking "Dialer" focuses the
existing Dialer tab instead of opening a duplicate (two Dialer tabs
would mean two phone registrations — see PhoneContext.jsx), and links
clicked inside the Dialer tab open in the main tab rather than
navigating the Dialer away mid-shift.
==================================================
*/
export const DIALER_TAB_NAME = "cmx-dialer";
export const MAIN_TAB_NAME = "cmx-main";
export const DIALER_PATH = "/dialer";

const SEPARATE_DIALER_TAB_ROLES = ["supervisor", "training_quality"];

export function usesSeparateDialerTab(accessLevel) {
  return SEPARATE_DIALER_TAB_ROLES.includes(accessLevel);
}

// Pages that belong in the Dialer tab itself (the dialer, and the
// campaign picker it bounces to when no campaign is chosen yet).
export function isDialerTabPath(pathname) {
  return pathname === DIALER_PATH || pathname === "/select-campaign";
}

/*
Opens `path` in the tab called `name`, reusing that tab if it's already
open. window.open("", name) returns the existing tab WITHOUT reloading
it (important for the Dialer — a reload would drop a live call's page
state), or a fresh blank tab if there isn't one yet. Must be called
from a click handler, or the browser's popup blocker steps in — in
which case this falls back to navigating the current tab.

keepIfAlreadyOn(pathname): for an already-open tab, return true to just
bring it forward without navigating (the Dialer, when it's already on
the dialer — never reload it); otherwise it's sent to `path` (e.g. the
main tab, so "open Reports" actually shows Reports).
*/
export function openAppTab(path, name, keepIfAlreadyOn = () => false) {
  const tab = window.open("", name);
  if (!tab) {
    window.location.assign(path);
    return;
  }

  let currentPath = null; // null = brand-new blank tab
  try {
    if (tab.location.href !== "about:blank") currentPath = tab.location.pathname;
  } catch {
    currentPath = ""; // not readable — navigate it to be safe
  }

  if (currentPath === null || !keepIfAlreadyOn(currentPath)) {
    tab.location.href = path;
  }
  tab.focus();
}

export function openDialerTab() {
  openAppTab(DIALER_PATH, DIALER_TAB_NAME, isDialerTabPath);
}

export function openInMainTab(path) {
  openAppTab(path, MAIN_TAB_NAME);
}
