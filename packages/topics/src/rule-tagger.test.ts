import { describe, expect, test } from "bun:test";
import { tagTopics } from "./rule-tagger";

describe("tagTopics", () => {
  test("tags robotics content", () => {
    expect(tagTopics("we need robot arm calibration")).toContain("Technology/Robotics");
  });

  test("tags USPS content", () => {
    expect(tagTopics("USPS mail delivery is delayed again")).toContain("Infrastructure/USPS");
  });

  test("multi-label: a message can match more than one topic", () => {
    const topics = tagTopics("the AI agent helped debug a robot arm calibration bug");
    expect(topics).toContain("Technology/AI");
    expect(topics).toContain("Technology/Robotics");
    expect(topics).toContain("Technology/Coding");
  });

  test("falls back to Other when nothing matches", () => {
    expect(tagTopics("the sky is blue today")).toEqual(["Other"]);
  });
});
