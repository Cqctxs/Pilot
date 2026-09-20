export async function search(page, query) {
  if (!page) throw new Error('ZipRecruiter search requires a browser page');

  const keywords = String(query?.keywords || 'software intern').trim() || 'software intern';
  const requestedLocation = String(query?.location || 'Boston, MA').trim() || 'Boston, MA';
  const parsedLimit = Number(query?.limit);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(Math.floor(parsedLimit), 60)
    : 20;

  const results = [];
  const seen = new Set();

  for (let pageNumber = 1; pageNumber <= 3 && results.length < limit; pageNumber++) {
    const path = pageNumber === 1 ? '/jobs-search' : `/jobs-search/${pageNumber}`;
    const searchUrl = new URL(path, 'https://www.ziprecruiter.com');
    searchUrl.searchParams.set('search', keywords);
    searchUrl.searchParams.set('location', requestedLocation);

    const response = await page.goto(searchUrl.href, { waitUntil: 'domcontentloaded', timeout: 12000 });
    if (!response) throw new Error(`ZipRecruiter page ${pageNumber} did not return a response`);
    if (response.status() >= 400) {
      throw new Error(`ZipRecruiter page ${pageNumber} failed with HTTP ${response.status()}`);
    }

    try {
      await page.waitForFunction(() => {
        const heading = document.querySelector('main h1')?.textContent || '';
        return Boolean(document.querySelector('article[id^="job-card-"]')) ||
          /^\s*0\b/.test(heading) || /no (?:matching )?jobs/i.test(heading);
      }, { timeout: 8000 });
    } catch {
      const state = await page.evaluate(() => ({
        title: document.title,
        text: (document.body?.innerText || '').slice(0, 1000),
        heading: document.querySelector('main h1')?.textContent || ''
      }));
      if (/captcha|access denied|verify (?:you are|that you are) human|unusual traffic|blocked/i.test(`${state.title} ${state.text}`)) {
        throw new Error('ZipRecruiter served a challenge or block page');
      }
      throw new Error(`ZipRecruiter results did not load on page ${pageNumber}${state.heading ? ` (${state.heading.trim()})` : ''}`);
    }

    const extracted = await page.$$eval('article[id^="job-card-"]', (cards, baseSearchUrl) => {
      const localSeen = new Set();
      return cards.flatMap(card => {
        const key = card.id.replace(/^job-card-/, '');
        if (!key || localSeen.has(key)) return [];
        localSeen.add(key);

        const title = card.querySelector('[data-testid="serp-job-card-title"]')?.textContent?.trim() || '';
        const company = card.querySelector('[data-testid="job-card-company"]')?.textContent?.trim() || '';
        if (!title || !company) return [];

        const locationElement = card.querySelector('[data-testid="job-card-location"]');
        const locationLine = locationElement?.parentElement?.textContent?.trim() || '';
        const jobLocation = /\bremote\b/i.test(locationLine)
          ? 'Remote'
          : (locationElement?.textContent?.trim() || null);

        const detailUrl = new URL(baseSearchUrl);
        detailUrl.searchParams.set('lk', key);

        return [{
          key,
          title,
          company,
          location: jobLocation,
          url: detailUrl.href,
          employmentType: null,
          postedAt: null
        }];
      });
    }, searchUrl.href);

    if (extracted.length === 0) {
      const heading = await page.locator('main h1').first().textContent().catch(() => '');
      if (/^\s*0\b/.test(heading || '') || /no (?:matching )?jobs/i.test(heading || '')) break;
      throw new Error(`ZipRecruiter showed a non-empty results page but no job cards could be extracted on page ${pageNumber}`);
    }

    let added = 0;
    for (const item of extracted) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      const { key, ...record } = item;
      results.push(record);
      added++;
      if (results.length >= limit) break;
    }
    if (added === 0 || extracted.length < 20) break;
  }

  return results.slice(0, limit);
}
