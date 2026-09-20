export async function search(page, query) {
  const keywords = query?.keywords ?? '';
  const location = query?.location ?? '';
  const limit = Number.isFinite(Number(query?.limit)) && Number(query.limit) > 0
    ? Math.floor(Number(query.limit))
    : Infinity;

  const searchUrl = new URL('http://127.0.0.1:4100/jobs');
  if (keywords) searchUrl.searchParams.set('q', String(keywords));
  if (location) searchUrl.searchParams.set('loc', String(location));

  const response = await page.goto(searchUrl.href, {
    waitUntil: 'domcontentloaded',
    timeout: 8000
  });
  if (!response) throw new Error('Job search did not return an HTTP response');
  if (!response.ok()) throw new Error(`Job search failed with HTTP ${response.status()}`);

  try {
    await page.waitForSelector('.result-count', { timeout: 3000 });
  } catch {
    const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 300);
    if (/captcha|challenge|access denied|blocked/i.test(bodyText)) {
      throw new Error('Job search was blocked by a challenge or access-denied page');
    }
    throw new Error('Job search results container did not appear');
  }

  const records = await page.$$eval('article.job-card', cards => cards.map(card => {
    const link = card.querySelector('h2 a');
    const read = selector => {
      const value = card.querySelector(selector)?.textContent?.trim();
      return value || null;
    };
    return {
      title: link?.textContent?.trim() || null,
      company: read('.company'),
      location: read('.location'),
      url: link ? new URL(link.getAttribute('href'), document.baseURI).href : null,
      employmentType: read('.type'),
      postedAt: read('time')
    };
  }).filter(record => record.title && record.company && record.url));

  return records.slice(0, limit);
}
