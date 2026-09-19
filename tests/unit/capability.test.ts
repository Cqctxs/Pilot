import { describe, expect, it } from "vitest";
import {
  classifyEmploymentType,
  dedupeJobs,
  filterJobs,
  normalizeForMatch,
  toJob,
  type Job,
} from "../../src/capability/jobs.js";

function job(overrides: Partial<Job>): Job {
  return {
    id: "x",
    source: "test",
    title: "Software Engineer",
    company: "Acme",
    location: "Boston, MA",
    url: "https://example.test/1",
    type: "full-time",
    typeBasis: "source",
    postedAt: null,
    ...overrides,
  };
}

describe("normalization", () => {
  it("strips punctuation for matching", () => {
    expect(normalizeForMatch("Software Engineer, Backend Intern")).toBe(
      "software engineer backend intern",
    );
  });

  it("prefers the site's own employment type over the title", () => {
    expect(classifyEmploymentType("Software Engineer", "Internship")).toEqual({
      type: "internship",
      typeBasis: "source",
    });
  });

  it("falls back to the title and says so", () => {
    expect(classifyEmploymentType("Summer Intern, Platform", null)).toEqual({
      type: "internship",
      typeBasis: "title",
    });
  });

  it("does not guess when there is no signal", () => {
    expect(classifyEmploymentType("Software Engineer", null).type).toBe("unknown");
  });
});

describe("toJob", () => {
  it("drops records missing a required field", () => {
    expect(toJob("test", { title: "Engineer", url: null })).toBeNull();
    expect(toJob("test", { title: null, url: "https://example.test/1" })).toBeNull();
  });

  it("falls back to the source name when no company is extracted", () => {
    const result = toJob("acme-board", { title: "Engineer", url: "https://example.test/1" });
    expect(result?.company).toBe("acme-board");
  });

  it("gives the same posting the same id across runs", () => {
    const a = toJob("test", { title: "Engineer", url: "https://example.test/1" });
    const b = toJob("test", { title: "Engineer", url: "https://example.test/1" });
    expect(a?.id).toBe(b?.id);
  });
});

describe("filterJobs", () => {
  const jobs = [
    job({ title: "Software Engineering Intern", type: "internship" }),
    job({ title: "Product Manager", location: "Remote" }),
    job({ title: "Backend Engineer", location: "Austin, TX" }),
  ];

  it("requires every keyword to match", () => {
    expect(filterJobs(jobs, { keywords: "software intern" })).toHaveLength(1);
    expect(filterJobs(jobs, { keywords: "software designer" })).toHaveLength(0);
  });

  it("matches location case- and punctuation-insensitively", () => {
    expect(filterJobs(jobs, { location: "austin" })).toHaveLength(1);
  });

  it("filters by employment type", () => {
    expect(filterJobs(jobs, { type: "internship" })).toHaveLength(1);
  });
});

describe("dedupeJobs", () => {
  it("collapses the same posting cross-listed on two boards", () => {
    const merged = dedupeJobs([
      job({ source: "indeed", url: "https://indeed.test/1" }),
      job({ source: "linkedin", url: "https://linkedin.test/9" }),
    ]);
    expect(merged).toHaveLength(1);
  });

  it("keeps genuinely different postings", () => {
    const merged = dedupeJobs([job({}), job({ company: "Globex" })]);
    expect(merged).toHaveLength(2);
  });
});
