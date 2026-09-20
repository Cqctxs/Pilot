export async function search(page, query) {
  const keywords = query?.keywords == null ? "" : String(query.keywords);
  const location = query?.location == null ? "" : String(query.location);
  const requestedLimit = Number(query?.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.floor(requestedLimit)
    : 75;

  const results = [];
  const seen = new Set();

  for (let pageNumber = 0; pageNumber < 3 && results.length < limit; pageNumber++) {
    const params = new URLSearchParams();
    if (keywords) params.set("keywords", keywords);
    if (location) params.set("location", location);
    if (pageNumber) params.set("start", String(pageNumber * 25));

    const searchUrl = `https://www.linkedin.com/jobs/search?${params.toString()}`;
    const response = await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });
    if (!response || !response.ok()) {
      throw new Error(`LinkedIn jobs search failed to load (HTTP ${response ? response.status() : "no response"})`);
    }

    try {
      await page.waitForSelector("ul.jobs-search__results-list > li", { timeout: 8000 });
    } catch (_) {
      const state = await page.evaluate(() => ({
        title: document.title,
        text: (document.body?.innerText || "").slice(0, 4000)
      }));
      const text = `${state.title}\n${state.text}`;
      if (/captcha|security verification|challenge|unusual activity|access denied|temporarily blocked/i.test(text)) {
        throw new Error("LinkedIn served a challenge or block page");
      }
      if (/no matching jobs|no jobs found|couldn't find any jobs/i.test(text)) {
        break;
      }
      throw new Error("LinkedIn jobs results container did not appear");
    }

    const rows = await page.$$eval("ul.jobs-search__results-list > li", (items) =>
      items.map((li) => {
        const clean = (selector) => {
          const value = li.querySelector(selector)?.textContent;
          return value ? value.replace(/\s+/g, " ").trim() : null;
        };
        const link = li.querySelector("a.base-card__full-link");
        let url = link?.href || null;
        if (url) {
          try {
            const parsed = new URL(url, location.href);
            url = `${parsed.origin}${parsed.pathname}`;
          } catch (_) {}
        }
        return {
          title: clean("h3.base-search-card__title"),
          company: clean("h4.base-search-card__subtitle"),
          location: clean(".job-search-card__location"),
          url,
          employmentType: null,
          postedAt: clean("time")
        };
      })
    );

    let added = 0;
    for (const row of rows) {
      if (!row.title || !row.company || !row.url || seen.has(row.url)) continue;
      seen.add(row.url);
      results.push(row);
      added++;
      if (results.length >= limit) break;
    }
    if (rows.length === 0 || added === 0) break;
  }

  return results.slice(0, limit);
}
