import { Component, type ErrorInfo, type ReactNode } from "react";
import { recordWorldEvent } from "../lib/telemetry/blackbox";
import { captureConsoleError } from "../lib/telemetry/sentry";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/**
 * Last-resort render guard. Before this existed, a throw anywhere under
 * the app unmounted the whole tree to a black page, with the error
 * visible only in the browser console (the 2026-11-27 blank-prod
 * checks). The boundary records the error — black box + Sentry, with
 * the component stack — and leaves a reload affordance in place of
 * the void.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    recordWorldEvent("react.error", {
      message: error.message,
      name: error.name,
      stack: (error.stack ?? "").slice(0, 800),
      componentStack: (info.componentStack ?? "").slice(0, 800),
    });
    captureConsoleError(error, "react.error");
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#0a0e24",
          color: "#e6e9f5",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", padding: 24 }}>
          <p style={{ fontSize: 18, marginBottom: 8 }}>Something went wrong in the console.</p>
          <p style={{ opacity: 0.75, marginBottom: 16 }}>The error was recorded. Reloading usually clears it.</p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 18px",
              borderRadius: 8,
              border: "1px solid #3a4270",
              background: "#161c3f",
              color: "#e6e9f5",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
