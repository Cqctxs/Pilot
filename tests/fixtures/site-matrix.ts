export interface MatrixSite {
  id: string;
  name: string;
  url: string;
  /** Sample keyword used when the operation really is a search. */
  query?: string;
  contentType: "html" | "json";
  /** Human-auditable reason this source belongs in an automated live test. */
  access: string;
  policyUrl: string;
}

export interface MatrixGroup {
  category: "jobs" | "books" | "quotes";
  /** Existing interface to seed before automatic routing, when there is one. */
  seedCapability?: "jobs.search@1";
  sites: readonly [MatrixSite, MatrixSite];
}

/**
 * Low-volume public sources chosen for this test—not arbitrary production
 * pages. The HTML sites explicitly exist for scraping practice; the JSON sites
 * document free, unauthenticated public access. Keep this list small: compiling
 * performs several requests while it explores, validates and probes a script.
 */
export const SITE_MATRIX: readonly MatrixGroup[] = [
  {
    category: "jobs",
    seedCapability: "jobs.search@1",
    sites: [
      {
        id: "fake-python-jobs",
        name: "Real Python fake jobs board",
        url: "https://realpython.github.io/fake-jobs/",
        query: "python",
        contentType: "html",
        access: "Static example job board that Real Python explicitly says can be freely scraped for practice.",
        policyUrl: "https://realpython.com/beautiful-soup-web-scraper-python/",
      },
      {
        id: "arbeitnow",
        name: "Arbeitnow public job-board API",
        url: "https://www.arbeitnow.com/api/job-board-api",
        query: "developer",
        contentType: "json",
        access: "Public HTTPS job feed with no authentication.",
        policyUrl: "https://documenter.getpostman.com/view/18545278/UVJbJdKh",
      },
    ],
  },
  {
    category: "books",
    sites: [
      {
        id: "books-demo",
        name: "Books to Scrape",
        url: "https://books.toscrape.com/",
        contentType: "html",
        access: "Zyte demo bookstore created specifically for web-scraping practice.",
        policyUrl: "https://books.toscrape.com/",
      },
      {
        id: "openlibrary",
        name: "Open Library subject catalog",
        url: "https://openlibrary.org/subjects/science_fiction.json?limit=20",
        contentType: "json",
        access: "Documented public JSON API; this suite stays within its low-volume default limit.",
        policyUrl: "https://openlibrary.org/developers/api",
      },
    ],
  },
  {
    category: "quotes",
    sites: [
      {
        id: "quotes-demo",
        name: "Quotes to Scrape",
        url: "https://quotes.toscrape.com/",
        contentType: "html",
        access: "Zyte demonstration site intended for scraping exercises.",
        policyUrl: "https://quotes.toscrape.com/",
      },
      {
        id: "dummyjson-quotes",
        name: "DummyJSON quotes",
        url: "https://dummyjson.com/quotes?limit=30",
        contentType: "json",
        access: "Free fake REST dataset documented for testing and prototyping.",
        policyUrl: "https://dummyjson.com/docs/quotes",
      },
    ],
  },
] as const;
