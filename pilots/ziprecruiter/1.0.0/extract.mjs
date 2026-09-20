export async function search(page, query) {
  const keywords = query?.keywords == null ? "" : String(query.keywords);
  const location = query?.location == null ? "" : String(query.location);
  const requested = Number(query?.limit);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 20;
  const maxPages = Math.min(2, Math.max(1, Math.ceil(limit / 20)));
  const results = [];
  const seenUrls = new Set();

  for (let pageNumber = 1; pageNumber <= maxPages && results.length < limit; pageNumber++) {
    const path = pageNumber === 1 ? "/jobs-search" : `/jobs-search/${pageNumber}`;
    const params = new URLSearchParams();
    if (keywords) params.set("search", keywords);
    if (location) params.set("location", location);
    const url = `https://www.ziprecruiter.com${path}?${params.toString()}`;

    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12000 });
    if (!response) throw new Error(`ZipRecruiter search page ${pageNumber} did not return a response`);
    if (response.status() >= 400) throw new Error(`ZipRecruiter search page ${pageNumber} returned HTTP ${response.status()}`);

    try {
      await page.waitForFunction(() => {
        const body = document.body?.innerText || "";
        if (/captcha|verify (that )?you are human|access denied|unusual traffic|just a moment/i.test(body)) return true;
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const data = JSON.parse(script.textContent || "");
            if (data?.["@type"] === "ItemList") {
              const items = Array.isArray(data.itemListElement) ? data.itemListElement : [];
              if (items.length === 0 || document.querySelector('article[id^="job-card-"]')) return true;
            }
          } catch {}
        }
        return /no jobs found|no matching jobs|couldn.t find any jobs|0 jobs\b/i.test(body);
      }, { timeout: 6000 });
    } catch {
      const diagnostic = await page.evaluate(() => ({
        title: document.title,
        text: (document.body?.innerText || "").slice(0, 500)
      }));
      throw new Error(`ZipRecruiter results did not load on page ${pageNumber}: ${diagnostic.title || diagnostic.text}`);
    }

    const blocked = await page.evaluate(() => {
      const text = `${document.title}\n${document.body?.innerText || ""}`;
      return /captcha|verify (that )?you are human|access denied|unusual traffic|just a moment/i.test(text);
    });
    if (blocked) throw new Error(`ZipRecruiter served a challenge or block page on page ${pageNumber}`);

    const extracted = await page.evaluate(() => {
      let itemList = null;
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(script.textContent || "");
          if (data?.["@type"] === "ItemList") {
            itemList = data;
            break;
          }
        } catch {}
      }

      const noResults = /no jobs found|no matching jobs|couldn.t find any jobs|0 jobs\b/i.test(document.body?.innerText || "");
      if (!itemList) return { error: noResults ? null : "Job ItemList structured data was missing", rows: [] };
      const items = Array.isArray(itemList.itemListElement) ? itemList.itemListElement : [];
      if (!items.length) return { error: null, rows: [] };

      const seenIds = new Set();
      const cards = Array.from(document.querySelectorAll('article[id^="job-card-"]')).filter(card => {
        if (!card.id || seenIds.has(card.id)) return false;
        seenIds.add(card.id);
        return true;
      });
      if (!cards.length) return { error: "Job cards were missing despite non-empty structured data", rows: [] };

      const rows = cards.map((card, index) => {
        const item = items[index] || null;
        const title = card.querySelector('[data-testid="serp-job-card-title"] h2, h2')?.textContent?.trim() || item?.name?.trim() || null;
        const company = card.querySelector('[data-testid="job-card-company"]')?.textContent?.trim() || null;
        const locationNode = card.querySelector('[data-testid="job-card-location"]');
        const locationLine = locationNode?.parentElement?.textContent?.trim() || "";
        const workLocation = /\bremote\b/i.test(locationLine) ? "Remote" : (locationNode?.textContent?.trim() || null);
        let jobUrl = null;
        if (item?.url) {
          try { jobUrl = new URL(item.url, document.baseURI).href; } catch {}
        }
        return {
          title,
          company,
          location: workLocation,
          url: jobUrl,
          employmentType: null,
          postedAt: null
        };
      });
      return { error: null, rows };
    });

    if (extracted.error) throw new Error(`ZipRecruiter extraction failed on page ${pageNumber}: ${extracted.error}`);
    if (!extracted.rows.length) break;

    let newCount = 0;
    for (const row of extracted.rows) {
      if (!row.title || !row.company || !row.url) {
        throw new Error(`ZipRecruiter returned a job missing a required title, company, or URL on page ${pageNumber}`);
      }
      if (seenUrls.has(row.url)) continue;
      seenUrls.add(row.url);
      results.push(row);
      newCount++;
      if (results.length >= limit) break;
    }
    if (newCount === 0) break;
  }

  return results.slice(0, limit);
}
