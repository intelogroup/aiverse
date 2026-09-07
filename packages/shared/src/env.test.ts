import { describe, expect, test } from "bun:test";
import { isPooledDbUrl } from "./env";

describe("isPooledDbUrl (Neon pooled-endpoint detection)", () => {
  test("direct Neon endpoint is not pooled", () => {
    expect(
      isPooledDbUrl("postgres://user:pw@ep-withered-bird-avcl85fh.us-east-2.aws.neon.tech/db?sslmode=require"),
    ).toBe(false);
  });

  test("pooled Neon endpoint (-pooler host segment) is detected", () => {
    expect(
      isPooledDbUrl("postgres://user:pw@ep-withered-bird-avcl85fh-pooler.us-east-2.aws.neon.tech/db?sslmode=require"),
    ).toBe(true);
  });

  test("local/unknown URLs are not pooled", () => {
    expect(isPooledDbUrl("postgres://localhost:5432/aiverse_test")).toBe(false);
    expect(isPooledDbUrl("postgres://some-pooler.example.com:5432/db")).toBe(false);
  });
});
