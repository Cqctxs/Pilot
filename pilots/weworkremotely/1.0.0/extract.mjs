export async function search(page, query) {
  query = query || {};
  const keywords = String(query.keywords || '').trim();
  const requestedLocation = String(query.location || '').trim();
  const target = 'https://weworkremotely.com/categories/remote-programming-jobs';

  const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 10000 });
  if (!response) throw new Error('We Work Remotely did not return a navigation response');
  if (response.status() >= 400) throw new Error(`We Work Remotely listing failed with HTTP ${response.status()}`);

  const pageTitle = await page.title();
  if (/just a moment|attention required|captcha|security verification/i.test(pageTitle)) {
    throw new Error('We Work Remotely served a security challenge');
  }

  try {
    await page.waitForSelector('li.new-listing-container:not(.listing-ad) a.listing-link--unlocked', { timeout: 5000 });
  } catch {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (/captcha|security verification|verify you are human|just a moment/i.test(bodyText)) {
      throw new Error('We Work Remotely served a security challenge');
    }
    throw new Error('We Work Remotely results container did not load');
  }

  let records = await page.$$eval('li.new-listing-container:not(.listing-ad)', rows => {
    const clean = value => (value || '').replace(/\s+/g, ' ').trim();

    return rows.map(row => {
      const categories = [...row.querySelectorAll('.new-listing__categories__category')]
        .map(node => clean(node.textContent))
        .filter(Boolean);
      const employmentType = categories.find(value =>
        /^(Full[- ]?Time|Part[- ]?Time|Full-Time\/Part-Time|Contract|Freelance|Internship|Temporary)$/i.test(value)
      ) || null;
      const locations = categories.filter(value =>
        value !== employmentType &&
        !/^(Featured|Boosted|Top 100)$/i.test(value) &&
        !/^[$€£¥]/.test(value) &&
        !/(USD|EUR|GBP|CAD|AUD)(?:\s|$)/i.test(value)
      );
      const href = row.querySelector('a.listing-link--unlocked')?.getAttribute('href');
      return {
        title: clean(row.querySelector('.new-listing__header__title__text')?.textContent),
        company: clean(row.querySelector('.new-listing__company-name')?.textContent),
        location: locations.length ? locations.join(', ') : null,
        url: href ? new URL(href, window.location.href).href : null,
        employmentType,
        postedAt: clean(row.querySelector('.new-listing__header__icons__date')?.textContent) || null
      };
    }).filter(record => record.title && record.company && record.url);
  });

  if (!records.length) throw new Error('We Work Remotely loaded the listing but no valid job records could be extracted');

  const keywordTokens = keywords.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const locationNeedle = requestedLocation.toLocaleLowerCase();
  if (keywordTokens.length || locationNeedle) {
    records = records.filter(record => {
      const searchable = `${record.title} ${record.company} ${record.employmentType || ''}`.toLocaleLowerCase();
      const location = (record.location || '').toLocaleLowerCase();
      return keywordTokens.every(token => searchable.includes(token)) &&
        (!locationNeedle || location.includes(locationNeedle));
    });
  }

  const requestedLimit = Number(query.limit);
  return Number.isFinite(requestedLimit) && requestedLimit > 0
    ? records.slice(0, Math.floor(requestedLimit))
    : records;
}
