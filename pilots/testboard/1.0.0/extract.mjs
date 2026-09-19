export async function search(page, query) {
  const baseUrl = 'http://127.0.0.1:4100/jobs';
  const params = new URLSearchParams();
  params.set('q', query?.keywords || '');
  params.set('loc', query?.location || '');

  const url = `${baseUrl}?${params.toString()}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body');

  const jobs = await page.$$eval('article.job-card', (cards) => {
    const clean = (value) => {
      const text = (value || '').trim();
      return text || null;
    };

    return cards.map((card) => {
      const link = card.querySelector('h2 a');
      const title = clean(link?.textContent);
      const company = clean(card.querySelector('.company')?.textContent);
      const href = link?.getAttribute('href') || '';
      const url = href ? new URL(href, document.baseURI).href : null;
      const time = card.querySelector('time');

      return {
        title,
        company,
        location: clean(card.querySelector('.location')?.textContent),
        url,
        employmentType: clean(card.querySelector('.type')?.textContent),
        postedAt: clean(time?.getAttribute('datetime')) || clean(time?.textContent)
      };
    }).filter((job) => job.title && job.company && job.url);
  });

  const limit = Number(query?.limit) > 0 ? Number(query.limit) : jobs.length;
  return jobs.slice(0, limit);
}
