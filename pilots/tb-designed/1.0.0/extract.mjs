export async function search(page, query) {
  if (!page) throw new Error('A browser page is required for this job board');

  const params = new URLSearchParams();
  const keywords = query?.keywords == null ? '' : String(query.keywords).trim();
  const locationQuery = query?.location == null ? '' : String(query.location).trim();
  if (keywords) params.set('q', keywords);
  if (locationQuery) params.set('loc', locationQuery);

  const searchUrl = `http://127.0.0.1:4100/jobs${params.toString() ? `?${params}` : ''}`;
  const response = await page.goto(searchUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 5000
  });
  if (!response) throw new Error('Job search did not return an HTTP response');
  if (!response.ok()) throw new Error(`Job search failed with HTTP ${response.status()}`);

  try {
    await page.waitForSelector('.result-count', { timeout: 3000 });
  } catch {
    const title = await page.title().catch(() => 'unknown page');
    throw new Error(`Job search results container did not load (page: ${title})`);
  }

  const reportedCount = await page.$eval('.result-count', el => {
    const match = (el.textContent || '').match(/\d+/);
    return match ? Number(match[0]) : null;
  });
  if (reportedCount === null) throw new Error('Job search returned an invalid result count');

  const records = await page.$$eval('article.job-card', (cards, baseUrl) => cards.map(card => {
    const link = card.querySelector('h2 a');
    const text = selector => {
      const value = card.querySelector(selector)?.textContent?.trim();
      return value || null;
    };
    const href = link?.getAttribute('href');
    return {
      title: link?.textContent?.trim() || null,
      url: href ? new URL(href, baseUrl).href : null,
      company: text('.company'),
      location: text('.location'),
      employmentType: text('.type'),
      datePosted: card.querySelector('time')?.getAttribute('datetime')?.trim() || null
    };
  }), searchUrl);

  const valid = records.filter(record => record.title && record.url);
  if (reportedCount > 0 && valid.length === 0) {
    throw new Error(`Job search reported ${reportedCount} results but no valid job cards were readable`);
  }

  let limit = Infinity;
  if (query?.limit !== null && query?.limit !== undefined && query.limit !== '') {
    const parsed = Number(query.limit);
    if (Number.isFinite(parsed) && parsed >= 0) limit = Math.floor(parsed);
  }
  return valid.slice(0, limit);
}
