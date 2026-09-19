export async function search(page, query) {
  const keywords = query?.keywords || '';
  const location = query?.location || '';
  const requestedLimit = Number(query?.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : Infinity;

  const results = [];
  const seen = new Set();

  for (let p = 1; p <= 3 && results.length < limit; p++) {
    const params = new URLSearchParams();
    if (keywords) params.set('k', keywords);
    if (location) params.set('l', location);
    if (p > 1) params.set('p', String(p));
    const url = `https://www.talent.com/jobs?${params.toString()}`;

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector('article[data-testid="job-card-unified"]', { timeout: 10000 });
    } catch (e) {
      break;
    }

    const pageJobs = await page.$$eval('article[data-testid="job-card-unified"]', (cards) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const empRe = /^(Full-time|Part-time|Permanent|Temporary|Contract|Internship|Freelance|Apprenticeship|Volunteer|Seasonal|Casual|Per diem)(\s*\+\d+)?$/i;

      return cards.map((el) => {
        const title = clean(el.querySelector('h2')?.textContent);

        const metaSpans = Array.from(el.querySelectorAll('address span'))
          .map((s) => clean(s.textContent))
          .filter((s) => s && s !== '•');
        const company = metaSpans[0] || '';
        const location = metaSpans[1] || null;

        const href = el.querySelector('a[href*="/view"]')?.getAttribute('href') || el.querySelector('a[href]')?.getAttribute('href') || '';
        const url = href ? new URL(href, window.location.href).href : '';

        const lines = (el.innerText || '').split('\n').map(clean).filter(Boolean);
        const employmentType = lines.find((line) => empRe.test(line)) || null;
        const postedAt = clean(el.querySelector('time')?.textContent) || lines.find((line) => /^(Last updated|Posted)/i.test(line)) || null;

        return { title, company, location, url, employmentType, postedAt };
      }).filter((job) => job.title && job.company && job.url);
    });

    if (!pageJobs.length) break;

    for (const job of pageJobs) {
      if (seen.has(job.url)) continue;
      seen.add(job.url);
      results.push(job);
      if (results.length >= limit) break;
    }
  }

  return results;
}
