// Colours remote cursors and selections in Monaco.
// y-monaco tags them with per-client classes (yRemoteSelection-<clientID>,
// yRemoteSelectionHead-<clientID>); this keeps a <style> element with one rule
// set per connected client, using the colour and name from awareness.

const STYLE_ID = "collab-presence-styles";

type AwarenessLike = {
  clientID: number;
  getStates(): Map<number, any>;
  on(event: "change", cb: () => void): void;
  off(event: "change", cb: () => void): void;
};

function cssString(s: string) {
  return JSON.stringify(s).replace(/</g, "\\3c ");
}

function safeColor(c: unknown) {
  const s = String(c ?? "");
  return /^[#a-z0-9(),.%\s-]+$/i.test(s) ? s : "#3b82f6";
}

function rulesFor(awareness: AwarenessLike) {
  let css = "";
  awareness.getStates().forEach((state, clientID) => {
    if (clientID === awareness.clientID) return;
    const user = state?.user;
    if (!user) return;
    const color = safeColor(user.color);
    css += `
.yRemoteSelection-${clientID} { background-color: ${color}; opacity: 0.25; }
.yRemoteSelectionHead-${clientID} {
  position: absolute;
  border-left: 2px solid ${color};
  border-top: 2px solid ${color};
  border-bottom: 2px solid ${color};
  height: 100%;
  box-sizing: border-box;
}
.yRemoteSelectionHead-${clientID}::after {
  content: ${cssString(String(user.name ?? ""))};
  position: absolute;
  top: -1.4em;
  left: -2px;
  padding: 1px 5px;
  font-size: 11px;
  line-height: 1.2;
  border-radius: 4px 4px 4px 0;
  background: ${color};
  color: #fff;
  white-space: nowrap;
  pointer-events: none;
  z-index: 10;
}`;
  });
  return css;
}

/** Keeps presence CSS in sync with awareness. Returns a cleanup function. */
export function attachPresenceStyles(awareness: AwarenessLike): () => void {
  if (typeof document === "undefined") return () => {};

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  const el = style;

  const update = () => {
    el.textContent = rulesFor(awareness);
  };
  update();
  awareness.on("change", update);

  return () => {
    awareness.off("change", update);
    el.remove();
  };
}
