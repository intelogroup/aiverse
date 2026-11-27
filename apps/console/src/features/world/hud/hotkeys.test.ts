import { describe, expect, it } from "vitest";
import { hotkeyFor, type HotkeyEvent } from "./hotkeys";

const key = (code: string, over: Partial<HotkeyEvent> = {}): HotkeyEvent => ({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: document.body, ...over });
const idle = { walking: false, modalOpen: false };
const ALL = ["KeyF", "KeyT", "KeyG", "KeyR", "KeyH", "Escape"];

describe("hotkeyFor", () => {
  it("maps the hotbar keys", () => {
    expect(ALL.map((c) => hotkeyFor(key(c), idle))).toEqual(["follow", "walk", "agents", "record", "hide", "menu"]);
  });

  it("takes nothing while walking or with a modal open, and never a walk key", () => {
    for (const c of ALL) {
      expect(hotkeyFor(key(c), { ...idle, walking: true })).toBeNull();
      expect(hotkeyFor(key(c), { ...idle, modalOpen: true })).toBeNull();
    }
    for (const c of ["KeyW", "KeyA", "KeyS", "KeyD", "KeyE", "KeyV", "ShiftLeft", "ArrowUp"]) expect(hotkeyFor(key(c), idle)).toBeNull();
  });

  it("leaves browser shortcuts, held keys and typing alone", () => {
    for (const over of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { repeat: true }, { target: document.createElement("input") }])
      expect(hotkeyFor(key("KeyR", over), idle)).toBeNull();
  });
});
