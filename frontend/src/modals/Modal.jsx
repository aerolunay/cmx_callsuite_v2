import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/*
==================================================
MODAL — shared shell for every modal in this app
==================================================
Per explicit request, a modal can ONLY be closed by its own Cancel
button or the × in its upper-right corner — never by clicking the
backdrop or pressing Escape, so a half-filled form can't be lost by a
stray click.

While open, the rest of the app is disabled: the modal renders into
document.body (outside #root) and #root is marked `inert`, which blocks
clicks, focus, and keyboard input on everything behind it, including
MiniPhone's page-wide keypad shortcuts. Page scroll is locked too.
Focus moves into the modal on open and returns to whatever had it
before on close.

onClose: wired to the × button; omit it to show no ×.
closeDisabled: disables the × (e.g. while a save is in flight).
==================================================
*/

// How many modals are open right now — #root stays inert until the
// last one closes.
let openCount = 0;

export default function Modal({ title, onClose, closeDisabled = false, width, cardStyle, children }) {
  const cardRef = useRef(null);

  useEffect(() => {
    const root = document.getElementById("root");
    const previouslyFocused = document.activeElement;

    openCount += 1;
    root?.setAttribute("inert", "");
    document.body.style.overflow = "hidden";

    const card = cardRef.current;
    const autoFocusTarget = card?.querySelector("[autofocus]");
    (autoFocusTarget || card)?.focus();

    return () => {
      openCount -= 1;
      if (openCount === 0) {
        root?.removeAttribute("inert");
        document.body.style.overflow = "";
      }
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  return createPortal(
    <div className="modal-overlay">
      <div
        ref={cardRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ ...(width ? { width } : {}), ...cardStyle }}
      >
        {(title || onClose) && (
          <div className="modal-header">
            {title && <h3>{title}</h3>}
            {onClose && (
              <button
                type="button"
                className="modal-close"
                onClick={onClose}
                disabled={closeDisabled}
                aria-label="Close"
                title="Close"
              >
                ×
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body
  );
}
