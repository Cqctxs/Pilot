export async function search(page, query) {
  const keywords = query && query.keywords ? String(query.keywords) : "";
  const location = query && query.location ? String(query.location) : "";
  const requestedLimit = query && Number(query.limit) > 0 ? Number(query.limit) : 30;
  const maxResults = Math.min(requestedLimit, 30);
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  };

  function decodeHtml(value) {
    const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
    return String(value || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
        if (ent[0] === "#") {
          const isHex = ent[1] && ent[1].toLowerCase() === "x";
          const n = parseInt(ent.slice(isHex ? 2 : 1), isHex ? 16 : 10);
          return Number.isFinite(n) ? String.fromCodePoint(n) : m;
        }
        return Object.prototype.hasOwnProperty.call(named, ent) ? named[ent] : m;
      })
      .replace(/\s+/g, " ")
      .trim();
  }

  function attr(tag, name) {
    const re = new RegExp(name + "\\s*=\\s*([\\\"'])([\\s\\S]*?)\\1", "i");
    const m = String(tag || "").match(re);
    return m ? decodeHtml(m[2]) : null;
  }

  function firstText(html, regex) {
    const m = String(html || "").match(regex);
    return m ? decodeHtml(m[1]) : null;
  }

  function parseCards(html) {
    const lis = String(html || "").match(/<li\b[\s\S]*?<\/li>/gi) || [];
    const out = [];
    for (const li of lis) {
      const aTag = (li.match(/<a\b[^>]*base-card__full-link[^>]*>/i) || [""])[0];
      const href = attr(aTag, "href");
      let url = null;
      try { url = href ? new URL(href, "https://www.linkedin.com").href : null; } catch (e) {}

      const title = firstText(li, /<h3\b[^>]*base-search-card__title[^>]*>([\s\S]*?)<\/h3>/i) ||
                    firstText(li, /<span\b[^>]*sr-only[^>]*>([\s\S]*?)<\/span>/i);
      const company = firstText(li, /<h4\b[^>]*base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/i);
      const loc = firstText(li, /<span\b[^>]*job-search-card__location[^>]*>([\s\S]*?)<\/span>/i);
      const posted = firstText(li, /<time\b[^>]*>([\s\S]*?)<\/time>/i);

      if (title && company && url) {
        out.push({
          title,
          company,
          location: loc || null,
          url,
          employmentType: null,
          postedAt: posted || null
        });
      }
    }
    return out;
  }

  function jobIdFromUrl(url) {
    const m = String(url || "").match(/-(\d+)(?:\?|$)/);
    return m ? m[1] : null;
  }

  async function fetchText(url) {
    const res = await fetch(url, { headers });
    if (!res.ok) return "";
    return await res.text();
  }

  async function employmentTypeFor(job) {
    const id = jobIdFromUrl(job.url);
    if (!id) return null;
    try {
      const html = await fetchText("https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/" + encodeURIComponent(id));
      return firstText(
        html,
        /<h3\b[^>]*description__job-criteria-subheader[^>]*>\s*Employment type\s*<\/h3>[\s\S]*?<span\b[^>]*description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/i
      ) || null;
    } catch (e) {
      return null;
    }
  }

  const results = [];
  const seen = new Set();
  for (let pageNum = 0; pageNum < 3 && results.length < maxResults; pageNum++) {
    const start = pageNum * 10;
    const url = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=" +
      encodeURIComponent(keywords) + "&location=" + encodeURIComponent(location) + "&start=" + start;
    let cards = [];
    try {
      cards = parseCards(await fetchText(url));
    } catch (e) {
      cards = [];
    }
    if (!cards.length) break;
    for (const card of cards) {
      const id = jobIdFromUrl(card.url) || card.url;
      if (!seen.has(id)) {
        seen.add(id);
        results.push(card);
        if (results.length >= maxResults) break;
      }
    }
  }

  for (const job of results) {
    job.employmentType = await employmentTypeFor(job);
  }

  return results.slice(0, maxResults);
}
