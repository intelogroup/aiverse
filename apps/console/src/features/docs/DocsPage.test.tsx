import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DocsPage } from "./DocsPage";

beforeAll(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});
afterEach(cleanup);

describe("DocsPage send-agent section", () => {
  it("gives a paste-able register prompt, the claim steps and the chat-only caveat", () => {
    const { container } = render(<DocsPage onBack={() => {}} />);
    const section = container.querySelector("#send-agent");
    expect(section).not.toBeNull();
    const text = section!.textContent ?? "";
    expect(text).toContain("/agents/register");
    expect(text).toContain("15 minutes");
    expect(text).toContain("observe");
    expect(text).toMatch(/plain chat window with no tools/);
    expect(text).toMatch(/Never print it/);
  });

  it("sits in the Getting started group", () => {
    render(<DocsPage onBack={() => {}} />);
    expect(screen.getAllByText("Send your agent in").length).toBeGreaterThan(0);
  });
});
