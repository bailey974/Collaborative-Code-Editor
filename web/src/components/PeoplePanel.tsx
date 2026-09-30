import type { CSSProperties } from "react";
import { useCollab, type RoomRole } from "../collab/CollabProvider";

/** Who's in the room, their roles, and (for the host) pending edit requests. */
export default function PeoplePanel() {
  const {
    room,
    me,
    role,
    isHost,
    members,
    defaultRole,
    setDefaultRole,
    setMemberRole,
    editRequests,
    resolveEditRequest,
  } = useCollab();

  return (
    <div style={{ height: "100%", overflow: "auto", padding: 10, fontSize: 13 }}>
      <section style={{ marginBottom: 14 }}>
        <div style={heading}>Invite</div>
        <div style={{ opacity: 0.8, marginBottom: 6 }}>
          Share this join code. People join from <b>Rooms → Join</b>.
        </div>
        <button
          onClick={() => void navigator.clipboard.writeText(room.joinCode).catch(() => {})}
          title="Copy join code"
          style={{ ...btn, fontFamily: "ui-monospace, monospace", fontSize: 15, letterSpacing: 2 }}
        >
          {room.joinCode}
        </button>
      </section>

      {isHost && (
        <section style={{ marginBottom: 14 }}>
          <div style={heading}>New people join as</div>
          <select
            value={defaultRole}
            onChange={(e) => setDefaultRole(e.target.value as "viewer" | "editor")}
            style={select}
          >
            <option value="viewer">Viewer (read-only)</option>
            <option value="editor">Editor</option>
          </select>
        </section>
      )}

      {isHost && editRequests.length > 0 && (
        <section style={{ marginBottom: 14 }}>
          <div style={heading}>Edit requests</div>
          {editRequests.map((r) => (
            <div key={r.id} style={{ ...row, alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{r.requestedBy.name}</b> wants to edit
                <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, wordBreak: "break-all" }}>
                  {r.path}
                </div>
              </div>
              <button style={btn} onClick={() => resolveEditRequest(r.id, true)}>
                Allow
              </button>
              <button style={btn} onClick={() => resolveEditRequest(r.id, false)}>
                Deny
              </button>
            </div>
          ))}
        </section>
      )}

      <section>
        <div style={heading}>Online ({members.length}/{room.maxUsers})</div>
        {members.map((m) => (
          <div key={m.userId} style={row}>
            <span
              style={{ width: 10, height: 10, borderRadius: 999, background: m.color, flex: "0 0 auto" }}
            />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {m.name}
              {m.userId === me.userId && <span style={{ opacity: 0.6 }}> (you)</span>}
            </span>
            {isHost && m.role !== "host" ? (
              <select
                value={m.role}
                onChange={(e) => setMemberRole(m.userId, e.target.value as Exclude<RoomRole, "host">)}
                style={select}
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
            ) : (
              <span style={badge}>{m.role}</span>
            )}
          </div>
        ))}
        {!isHost && role === "viewer" && (
          <div style={{ marginTop: 10, opacity: 0.75 }}>
            You're a viewer. Use <b>Request edit</b> on a file, or ask the host to make you an editor.
          </div>
        )}
      </section>
    </div>
  );
}

const heading: CSSProperties = {
  fontWeight: 600,
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "#4B5563",
  marginBottom: 6,
};

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "5px 0",
};

const btn: CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid #d1d5db",
  background: "#fff",
  cursor: "pointer",
  fontSize: 12,
};

const select: CSSProperties = {
  padding: "3px 6px",
  borderRadius: 6,
  border: "1px solid #d1d5db",
  fontSize: 12,
};

const badge: CSSProperties = {
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid rgba(0,0,0,0.15)",
  background: "rgba(0,0,0,0.04)",
  textTransform: "capitalize",
};
