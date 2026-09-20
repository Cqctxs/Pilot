export async function search(page, query) {
  const defaultKeywords = 'software intern';
  const defaultLocation = 'Boston';
  const keywords = String(query?.keywords || defaultKeywords).trim();
  const location = String(query?.location || defaultLocation).trim();
  const requestedLimit = Number(query?.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.floor(requestedLimit)
    : 60;

  const base = new URL('https://www.talent.com/jobs');
  if (keywords) base.searchParams.set('k', keywords);
  if (location) base.searchParams.set('l', location);

  const results = [];
  const seen = new Set();

  for (let pageNumber = 1; pageNumber <= 3 && results.length < limit; pageNumber++) {
    const url = new URL(base.href);
    if (pageNumber > 1) url.searchParams.set('p', String(pageNumber));

    const response = await page.goto(url.href, {
      waitUntil: 'domcontentloaded',
      timeout: 12000
    });
    if (!response) throw new Error(`Talent.com did not return a response for page ${pageNumber}`);
    if (!response.ok()) throw new Error(`Talent.com returned HTTP ${response.status()} for page ${pageNumber}`);

    try {
      await page.waitForFunction(
        () => document.querySelector('article[data-testid="job-card-unified"]') ||
              document.querySelector('[data-testid="searchNoJobFound"]'),
        null,
        { timeout: 6000 }
      );
    } catch {
      const diagnosis = await page.evaluate(() => ({
        title: document.title,
        text: (document.body?.innerText || '').slice(0, 1200)
      }));
      if (/captcha|access denied|verify (that )?you are human|unusual traffic|just a moment/i.test(`${diagnosis.title} ${diagnosis.text}`)) {
        throw new Error('Talent.com served a challenge or block page');
      }
      throw new Error(`Talent.com results did not load on page ${pageNumber}`);
    }

    const extracted = await page.evaluate(() => {
      const noResults = Boolean(document.querySelector('[data-testid="searchNoJobFound"]'));
      const records = [...document.querySelectorAll('article[data-testid="job-card-unified"]')].map(article => {
        const clean = value => value ? value.replace(/\s+/g, ' ').trim() : null;
        const addressParts = [...article.querySelectorAll('address span')]
          .map(span => clean(span.textContent))
          .filter(Boolean);
        const link = article.querySelector('a[href*="/view?id="]');

        const body = article.querySelector(':scope > div');
        const badgeBox = body?.querySelector(':scope > div:first-child');
        const badges = badgeBox
          ? [...badgeBox.children].map(node => clean(node.textContent)).filter(Boolean)
          : [];
        const employmentType = badges.find(text =>
          !/\$|€|£|¥|hourly|annually|yearly|daily|weekly|monthly|quick apply|new!/i.test(text)
        ) || null;

        return {
          title: clean(article.querySelector('h2')?.textContent),
          company: addressParts[0] || null,
          location: addressParts.length > 1 ? addressParts[addressParts.length - 1] : null,
          url: link ? new URL(link.getAttribute('href'), window.location.origin).href : null,
          employmentType,
          postedAt: clean(article.querySelector('time')?.textContent)
        };
      });

      const next = document.querySelector('a[aria-label="Next page"]');
      const hasNext = Boolean(next && next.getAttribute('aria-disabled') !== 'true');
      return { noResults, records, hasNext };
    });

    if (extracted.noResults) {
      if (pageNumber === 1) return [];
      break;
    }
    if (!extracted.records.length) {
      throw new Error(`Talent.com returned a results page without readable job cards on page ${pageNumber}`);
    }

    for (const record of extracted.records) {
      if (!record.title || !record.company || !record.url) continue;
      if (seen.has(record.url)) continue;
      seen.add(record.url);
      results.push(record);
      if (results.length >= limit) break;
    }

    if (!extracted.hasNext) break;
  }

  return results.slice(0, limit);
}
