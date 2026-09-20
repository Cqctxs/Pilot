export async function search(page, query) {
  const clean = value => typeof value === 'string' ? value.trim() : '';
  let keywords = clean(query && query.keywords);
  let location = clean(query && query.location);

  // With no caller-supplied search terms, preserve the target page's default listing.
  if (!keywords && !location) {
    keywords = 'software intern';
    location = 'Boston';
  }

  const requestedLimit = Number(query && query.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.floor(requestedLimit)
    : 25;
  const results = [];
  const seen = new Set();

  for (let pageIndex = 0; pageIndex < 3 && results.length < limit; pageIndex++) {
    const params = new URLSearchParams();
    if (keywords) params.set('keywords', keywords);
    if (location) params.set('location', location);
    params.set('start', String(pageIndex * 10));
    const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`;

    let response;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
    } catch (error) {
      throw new Error(`LinkedIn jobs search did not load: ${error.message}`);
    }
    if (!response) throw new Error('LinkedIn jobs search returned no HTTP response');
    const status = response.status();
    if (status < 200 || status >= 300) {
      throw new Error(`LinkedIn jobs search failed with HTTP ${status}`);
    }

    const pageState = await page.evaluate(() => ({
      count: document.querySelectorAll('.base-search-card').length,
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim(),
      htmlLength: document.body?.innerHTML.length || 0,
      url: location.href
    }));
    const blocked = /captcha|security verification|unusual activity|too many requests|sign in to continue|authwall/i.test(pageState.text) ||
      /checkpoint|authwall|challenge/i.test(pageState.url);
    if (blocked) throw new Error('LinkedIn served a login, captcha, or challenge page');

    if (pageState.count === 0) {
      // This endpoint represents a genuine no-match/end-of-results page as an empty body.
      if (pageState.text || pageState.htmlLength > 100) {
        throw new Error('LinkedIn returned an unexpected page without job records');
      }
      break;
    }

    await page.waitForSelector('.base-search-card', { timeout: 2000 });
    const rows = await page.$$eval('.base-search-card', cards => {
      const text = element => {
        const value = element?.textContent?.replace(/\s+/g, ' ').trim();
        return value || null;
      };
      return cards.map(card => {
        const link = card.querySelector('a.base-card__full-link');
        let url = null;
        if (link?.href) {
          const parsed = new URL(link.href, document.baseURI);
          parsed.search = '';
          parsed.hash = '';
          url = parsed.href;
        }
        return {
          title: text(card.querySelector('h3')),
          company: text(card.querySelector('h4')),
          location: text(card.querySelector('.job-search-card__location')),
          url,
          employmentType: null,
          postedAt: text(card.querySelector('time'))
        };
      });
    });

    let added = 0;
    for (const row of rows) {
      if (!row.title || !row.company || !row.url) continue;
      if (seen.has(row.url)) continue;
      seen.add(row.url);
      results.push(row);
      added++;
      if (results.length >= limit) break;
    }
    if (rows.length === 0 || added === 0) break;
  }

  return results.slice(0, limit);
}
