import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";
import { blackbox } from "../lib/telemetry/blackbox";

function Boom(): never {
  throw new Error("kaboom in the fountain");
}

afterEach(() => {
  cleanup();
  blackbox.clear();
});

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>all quiet</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("all quiet")).toBeTruthy();
    expect(blackbox.all().filter((e) => e.type === "react.error")).toHaveLength(0);
  });

  it("catches a render throw, records it in the black box, and shows the fallback", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
    } finally {
      spy.mockRestore();
    }
    expect(screen.getByText("Something went wrong in the console.")).toBeTruthy();
    expect(screen.getByText("Reload")).toBeTruthy();
    const recorded = blackbox.all().filter((e) => e.type === "react.error");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].data?.message).toBe("kaboom in the fountain");
  });
});
