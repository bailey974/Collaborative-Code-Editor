// src/collab/presenceStyles.ts
// Injects minimal CSS for remote cursor/selection “presence” UI.
// Safe no-op on SSR / non-browser environments.

const STYLE_ID = "collab-presence-styles";

const CSS = `
/* Generic remote selection highlight */
.y-presence-selection {
  background: rgba(59, 130, 246, 0.20);
}

/* Generic remote caret */
.y-presence-cursor {
  position: relative;
  display: inline;
  border-left: 2px solid rgba(59, 130, 246, 0.95);
  margin-left: -1px;
}

/* Label above caret (optional: set data-user="name") */
.y-presence-cursor::after {
  content: attr(data-user);
  position: absolute;
  top: -1.4em;
  left: 0;
  padding: 2px 6px;
  font-size: 11px;
  line-height: 1.2;
  border-radius: 6px;
  background: rgba(59, 130, 246, 0.95);
  color: white;
  white-space: nowrap;
  pointer-events: none;
}
`;

/**
 * Ensures the presence CSS exists in <head>.
 * Returns a cleanup function (removes the style if this call created it).
 */
export function attachPresenceStyles(): () => void {
  if (typeof document === "undefined") return () => {};

  const existing = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (existing) return () => {};

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);

  return () => {
    style.remove();
  };
}
