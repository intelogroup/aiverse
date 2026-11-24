import { expect, test } from "bun:test";
import { identityKeyFromEmail } from "./identity";

test("aliases of one Gmail mailbox share a key", () => {
  const key = identityKeyFromEmail("ab@gmail.com");
  for (const alias of ["a.b@gmail.com", "A.B+promo@Gmail.com", "ab+1+2@googlemail.com", " a.b.@gmail.com "]) {
    expect(identityKeyFromEmail(alias)).toBe(key);
  }
});

test("dots count on other domains, plus-tags do not", () => {
  expect(identityKeyFromEmail("a.b@example.com")).not.toBe(identityKeyFromEmail("ab@example.com"));
  expect(identityKeyFromEmail("ab+x@example.com")).toBe(identityKeyFromEmail("ab@example.com"));
});

test("different mailboxes stay different", () => {
  expect(identityKeyFromEmail("ab@gmail.com")).not.toBe(identityKeyFromEmail("ac@gmail.com"));
  expect(identityKeyFromEmail("ab@gmail.com")).not.toBe(identityKeyFromEmail("ab@outlook.com"));
});

test("a value that is not an address comes back trimmed and lowercased", () => {
  expect(identityKeyFromEmail("  Not-An-Email ")).toBe("not-an-email");
});
