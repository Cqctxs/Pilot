export async function search(page, query) {
  if (!page) throw new Error('Talent.com search requires a browser page');

  const keywords = query?.keywords == null ? '' : String(query.keywords).trim();
  const locationQuery = query?.location == null ? '' : String(query.location).trim();
  const requested = Number(query?.limit);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 20;
  const maxPages = Math.min(3, Math.max(1, Math.ceil(limit / 20)));
  const results = [];
  const seen = new Set();

  for (let pageNumber = 1; pageNumber <= maxPages && results.length < limit; pageNumber++) {
    const params = new URLSearchParams();
    if (keywords) params.set('k', keywords);
    if (locationQuery) params.set('l', locationQuery);
    if (pageNumber > 1) params.set('p', String(pageNumber));
    const searchUrl = `https://www.talent.com/jobs?${params.toString()}`;

    let response;
    try {
      response = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
    } catch (error) {
      throw new Error(`Talent.com search page ${pageNumber} did not load: ${error.message}`);
    }
    if (!response) throw new Error(`Talent.com search page ${pageNumber} returned no response`);
    if (response.status() >= 400) {
      throw new Error(`Talent.com search page ${pageNumber} returned HTTP ${response.status()}`);
    }

    try {
      await page.waitForSelector('article[data-testid="job-card-unified"], [data-testid="searchNoJobFound"]', { timeout: 10000 });
    } catch (error) {
      const diagnostic = await page.locator('body').innerText().catch(() => '');
      if (/captcha|verify you are human|access denied|unusual traffic|temporarily blocked/i.test(diagnostic)) {
        throw new Error('Talent.com served a captcha or access-block page');
      }
      throw new Error(`Talent.com search results did not appear on page ${pageNumber}`);
    }

    const noResults = await page.$('[data-testid="searchNoJobFound"]');
    const cardCount = await page.locator('article[data-testid="job-card-unified"]').count();
    if (noResults && cardCount === 0) break;
    if (cardCount === 0) throw new Error(`Talent.com page ${pageNumber} had no job cards or explicit no-results message`);

    const pageRecords = await page.$$eval('article[data-testid="job-card-unified"]', cards => cards.map(card => {
      const text = element => element?.textContent?.trim() || null;
      const meta = [...card.querySelectorAll('address span')]
        .filter(span => span.getAttribute('aria-hidden') !== 'true');
      const labels = [...card.querySelectorAll('svg[title]')]
        .map(svg => svg.getAttribute('title')?.trim())
        .filter(Boolean);
      const employmentType = labels.find(label => /^(?:full[- ]?time|part[- ]?time|permanent|temporary|contract(?:or)?|internship|seasonal|freelance|casual|apprenticeship)(?:\s*\+\d+)?$/i.test(label)) || null;
      const link = card.querySelector('a[href*="/view?"]');
      const href = link?.getAttribute('href');

      return {
        title: text(card.querySelector('h2')),
        company: text(meta[0]),
        location: text(meta[1]),
        url: href ? new URL(href, window.location.origin).href : null,
        employmentType,
        postedAt: text(card.querySelector('time'))
      };
    }));

    let added = 0;
    for (const record of pageRecords) {
      if (!record.title || !record.company || !record.url || seen.has(record.url)) continue;
      seen.add(record.url);
      results.push(record);
      added++;
      if (results.length >= limit) break;
    }
    if (added === 0 || pageRecords.length < 20) break;
  }

  return results.slice(0, limit);
}
