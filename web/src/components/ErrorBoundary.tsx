import React from "react";

type Props = { children: React.ReactNode };

type State = { error: any };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: any) {
    return { error };
  }

  componentDidCatch(error: any, info: any) {
    console.error("Render crash:", error, info);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  private reload = () => {
    // In Tauri + Vite this will reload the UI layer.
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 16,
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
            whiteSpace: "pre-wrap",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>App crashed:</div>
          <div style={{ marginBottom: 12, opacity: 0.9 }}>
            {String(this.state.error?.stack ?? this.state.error)}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={this.reset} style={btn}>
              Try again
            </button>
            <button onClick={this.reload} style={btn}>
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const btn: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid rgba(0,0,0,0.18)",
  background: "white",
  cursor: "pointer",
};
