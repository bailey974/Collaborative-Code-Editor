import React, { useEffect, useMemo, useRef, useState } from "react";
import { useCollab } from "../collab/CollabProvider";

type ChatMessage = {
  id: string;
  userId: string;
  name: string;
  text: string;
  createdAt: number;
};

const Y_CHAT = "chat:messages";
const MAX_MESSAGES = 500;

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? (crypto as any).randomUUID()
    : `msg-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

function formatTime(ts: number) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export default function ChatPanel() {
  const { doc, me } = useCollab();

  const yMessages = useMemo(() => doc.getArray<ChatMessage>(Y_CHAT), [doc]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [atBottom, setAtBottom] = useState(true);

  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const update = () => {
      const arr = yMessages
        .toArray()
        .filter((m: any) => m && typeof (m as any).text === "string")
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

      setMessages(arr);

      // Keep bounded size
      if (arr.length > MAX_MESSAGES) {
        const overflow = arr.length - MAX_MESSAGES;
        doc.transact(() => {
          yMessages.delete(0, overflow);
        });
      }
    };

    update();
    yMessages.observe(update);
    return () => yMessages.unobserve(update);
  }, [doc, yMessages]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      setAtBottom(nearBottom);
    };

    el.addEventListener("scroll", onScroll);
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!atBottom) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, atBottom]);

  function send() {
    const t = input.trim();
    if (!t) return;

    const msg: ChatMessage = {
      id: makeId(),
      userId: me.userId,
      name: me.name,
      text: t,
      createdAt: Date.now(),
    };

    doc.transact(() => {
      yMessages.push([msg]);
    });

    setInput("");
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: 10, borderBottom: "1px solid #e5e7eb", fontWeight: 600 }}>
        Chat
      </div>

      <div
        ref={scrollerRef}
        style={{ flex: "1 1 auto", minHeight: 0, overflow: "auto", padding: 10 }}
      >
        {messages.length === 0 ? (
          <div style={{ opacity: 0.7, fontSize: 12 }}>No messages yet.</div>
        ) : (
          messages.map((m) => {
            const mine = m.userId === me.userId;
            return (
              <div
                key={m.id}
                style={{
                  marginBottom: 10,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: mine ? "flex-end" : "flex-start",
                }}
              >
                <div style={{ fontSize: 11, opacity: 0.7 }}>
                  <span style={{ fontWeight: 600, color: mine ? "#111827" : undefined }}>
                    {mine ? "You" : m.name}
                  </span>{" "}
                  <span>{formatTime(m.createdAt)}</span>
                </div>
                <div
                  style={{
                    marginTop: 3,
                    maxWidth: "95%",
                    padding: "8px 10px",
                    borderRadius: 10,
                    background: mine ? "rgba(17,24,39,0.07)" : "rgba(0,0,0,0.04)",
                    border: "1px solid rgba(0,0,0,0.06)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {m.text}
                </div>
              </div>
            );
          })
        )}
      </div>

      {!atBottom && (
        <button
          onClick={() => {
            const el = scrollerRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          style={{
            margin: "0 10px 10px 10px",
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid #d1d5db",
            background: "#fff",
            cursor: "pointer",
          }}
        >
          Jump to latest
        </button>
      )}

      <div style={{ display: "flex", gap: 8, padding: 10, borderTop: "1px solid #e5e7eb" }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Type…"
          style={{
            flex: 1,
            padding: "8px 10px",
            border: "1px solid #d1d5db",
            borderRadius: 8,
            outline: "none",
          }}
        />
        <button
          onClick={send}
          style={{
            padding: "8px 12px",
            border: "1px solid #d1d5db",
            borderRadius: 8,
            background: "#fff",
            cursor: "pointer",
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
