export async function search(page, query) {
  const baseUrl = 'http://127.0.0.1:4200/jobs';
  const url = new URL(baseUrl);
  const keywords = query?.keywords == null ? '' : String(query.keywords).trim();
  const location = query?.location == null ? '' : String(query.location).trim();
  if (keywords) url.searchParams.set('q', keywords);
  if (location) url.searchParams.set('loc', location);

  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 10000 });
  if (!response) throw new Error('Jobs page did not return a response');
  if (!response.ok()) throw new Error(`Jobs page failed with HTTP ${response.status()}`);

  try {
    await page.waitForSelector('form[action="/jobs"] + .result-count', { timeout: 3000 });
  } catch {
    const title = await page.title().catch(() => '');
    throw new Error(`Jobs results container did not appear${title ? ` (page title: ${title})` : ''}`);
  }

  const state = await page.$$eval('body', (bodies) => {
    const body = bodies[0];
    const countText = body.querySelector('.result-count')?.textContent?.trim() || '';
    const cards = [...body.querySelectorAll('article.job-card')];
    const records = cards.map((card) => {
      const link = card.querySelector('h2 a');
      const value = (selector) => {
        const text = card.querySelector(selector)?.textContent?.trim();
        return text || null;
      };
      return {
        title: link?.textContent?.trim() || null,
        company: value('.company'),
        location: value('.location'),
        url: link ? new URL(link.getAttribute('href'), document.baseURI).href : null,
        employmentType: value('.type'),
        postedAt: value('time')
      };
    });
    return { countText, records };
  });

  if (!/^\d+\s+results?$/i.test(state.countText)) {
    throw new Error('Jobs page returned an unrecognized results state');
  }

  const declaredCount = Number.parseInt(state.countText, 10);
  if (declaredCount > 0 && state.records.length === 0) {
    throw new Error('Jobs page declared results but no job cards were readable');
  }

  let records = state.records.filter((record) => record.title && record.company && record.url);
  const limit = Number(query?.limit);
  if (Number.isFinite(limit) && limit > 0) records = records.slice(0, Math.floor(limit));
  return records;
}
