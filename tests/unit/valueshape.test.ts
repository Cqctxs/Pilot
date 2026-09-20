import { describe, expect, it } from "vitest";
import { classifyValue, dominantShape, fieldShape } from "../../src/capability/valueshape.js";

describe("classifyValue", () => {
  it("separates the two ways a job board reports a posting date", () => {
    expect(classifyValue("2026-09-14")).toBe("isoDate");
    expect(classifyValue("2026-09-14T08:30:00Z")).toBe("isoDate");
    expect(classifyValue("6 hours ago")).toBe("relativeTime");
    expect(classifyValue("Posted 3 days ago")).toBe("relativeTime");
    expect(classifyValue("30+ days ago")).toBe("relativeTime");
    expect(classifyValue("Yesterday")).toBe("relativeTime");
  });

  it("reads money as money rather than as a number", () => {
    expect(classifyValue("$120,000")).toBe("money");
    expect(classifyValue("$90k - $120k a year")).toBe("money");
    expect(classifyValue("75000 USD")).toBe("money");
    expect(classifyValue("120000")).toBe("number");
    expect(classifyValue("4.5")).toBe("number");
  });

  it("recognises urls, booleans, blanks and everything else", () => {
    expect(classifyValue("https://example.com/a")).toBe("url");
    expect(classifyValue("true")).toBe("boolean");
    expect(classifyValue("No")).toBe("boolean");
    expect(classifyValue(null)).toBe("empty");
    expect(classifyValue("   ")).toBe("empty");
    expect(classifyValue("Mid-Senior level")).toBe("text");
  });
});

describe("dominantShape", () => {
  it("ignores blanks instead of counting them", () => {
    expect(dominantShape([null, "", "2026-09-14", "2026-09-15"])).toBe("isoDate");
  });

  it("returns null when there is nothing to judge", () => {
    expect(dominantShape([null, "", "  "])).toBeNull();
    expect(dominantShape([])).toBeNull();
  });

  it("tolerates a minority of oddly shaped values", () => {
    expect(dominantShape(["2 days ago", "5 days ago", "2026-01-01"])).toBe("relativeTime");
  });
});

describe("fieldShape", () => {
  it("reads one field across a Pilot's sample records", () => {
    const samples = [
      { title: "Engineer", postedAt: "3 days ago" },
      { title: "Designer", postedAt: "1 week ago" },
    ];
    expect(fieldShape(samples, "postedAt")).toBe("relativeTime");
    expect(fieldShape(samples, "missing")).toBeNull();
  });
});
