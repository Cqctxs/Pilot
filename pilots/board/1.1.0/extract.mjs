export async function search(page, query) {
  const url = new URL('http://127.0.0.1:4200/jobs');
  const keywords = query?.keywords == null ? '' : String(query.keywords).trim();
  const location = query?.location == null ? '' : String(query.location).trim();
  if (keywords) url.searchParams.set('q', keywords);
  if (location) url.searchParams.set('loc', location);

  const response = await page.goto(url.href, {
    waitUntil: 'domcontentloaded',
    timeout: 10000
  });
  if (!response) throw new Error('Jobs page did not return a response');
  if (!response.ok()) throw new Error(`Jobs page failed with HTTP ${response.status()}`);

  try {
    await page.waitForSelector('.result-count', { timeout: 3000 });
  } catch {
    const title = await page.title().catch(() => '');
    throw new Error(`Jobs results state did not appear${title ? ` (page title: ${title})` : ''}`);
  }

  const state = await page.$$eval('body', (bodies) => {
    const body = bodies[0];
    const clean = (element) => {
      const text = element?.textContent?.trim() || '';
      return text && text !== '—' ? text : null;
    };

    const countText = body.querySelector('.result-count')?.textContent?.trim() || '';
    const records = [...body.querySelectorAll('table tbody tr')].map((row) => {
      const cells = row.querySelectorAll('td');
      const link = cells[0]?.querySelector('a');
      return {
        title: clean(link),
        company: clean(cells[1]),
        location: clean(cells[2]),
        url: link?.href || null,
        employmentType: clean(cells[3]),
        postedAt: clean(cells[4])
      };
    });

    return { countText, records };
  });

  const countMatch = state.countText.match(/^(\d+)\s+results?$/i);
  if (!countMatch) throw new Error('Jobs page returned an unrecognized results state');

  const declaredCount = Number.parseInt(countMatch[1], 10);
  if (declaredCount > 0 && state.records.length === 0) {
    throw new Error('Jobs page declared results but no posting rows were readable');
  }

  let records = state.records.filter((record) => record.title && record.company && record.url);
  if (declaredCount > 0 && records.length === 0) {
    throw new Error('Jobs page contained no records with the required fields');
  }

  const limit = Number(query?.limit);
  if (Number.isFinite(limit) && limit > 0) {
    records = records.slice(0, Math.floor(limit));
  }
  return records;
}
