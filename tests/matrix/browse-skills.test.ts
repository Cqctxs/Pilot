import { describe, expect, it } from "vitest";
import { findSkillNotesForUrl } from "../../src/compiler/skills.js";

const EXAMPLES = [
  {
    url: "https://www.indeed.com/jobs?q=software+engineer",
    capability: "jobs.search@1",
    source: "browse.sh:indeed.com/search-jobs-",
  },
  {
    url: "https://www.booking.com/searchresults.html?ss=Toronto",
    capability: "hotels.search@1",
    source: "browse.sh:booking.com/search-hotels-",
  },
] as const;

describe("automatic browse.sh examples", () => {
  for (const example of EXAMPLES) {
    it(`finds verified prior knowledge for ${new URL(example.url).hostname}`, async () => {
      const notes = await findSkillNotesForUrl(example.url, example.capability);
      expect(notes?.source).toContain(example.source);
      expect(notes?.markdown.length).toBeGreaterThan(500);
    });
  }
});
