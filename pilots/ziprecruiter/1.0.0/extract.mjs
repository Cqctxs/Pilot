export async function search(page, query) {
  query = query || {};
  const keywords = query.keywords || "";
  const where = query.location || "";
  const limit = Number(query.limit) > 0 ? Number(query.limit) : 60;

  const base = new URL("https://www.ziprecruiter.com/jobs-search");
  if (keywords) base.searchParams.set("search", keywords);
  if (where) base.searchParams.set("location", where);

  const results = [];
  const seen = new Set();

  for (let p = 1; p <= 3 && results.length < limit; p++) {
    const url = new URL(base.toString());
    if (p > 1) url.searchParams.set("page", String(p));

    try {
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await page.waitForFunction(
        () => document.querySelector('article[id^="job-card-"]') ||
              [...document.scripts].some(s => (s.textContent || "").includes("jobKeysMap")) ||
              /no jobs|no results|0 jobs/i.test(document.body.innerText || ""),
        null,
        { timeout: 20000 }
      ).catch(() => {});
    } catch (e) {
      break;
    }

    const pageRecords = await page.evaluate(() => {
      const clean = (s) => (s == null ? null : String(s).replace(/\s+/g, " ").trim() || null);
      const absolute = (u) => {
        if (!u) return null;
        try { return new URL(u, location.origin).href; } catch (e) { return null; }
      };
      const employmentName = (name) => {
        const map = {
          EMPLOYMENT_TYPE_NAME_FULL_TIME: "Full-time",
          EMPLOYMENT_TYPE_NAME_PART_TIME: "Part-time",
          EMPLOYMENT_TYPE_NAME_CONTRACT: "Contract",
          EMPLOYMENT_TYPE_NAME_TEMPORARY: "Temporary",
          EMPLOYMENT_TYPE_NAME_INTERNSHIP: "Internship",
          EMPLOYMENT_TYPE_NAME_PER_DIEM: "Per diem",
          EMPLOYMENT_TYPE_NAME_OTHER: "Other"
        };
        return map[name] || (name ? String(name).replace(/^EMPLOYMENT_TYPE_NAME_/, "").toLowerCase().replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : null);
      };

      function balancedObject(text, key) {
        const idx = text.indexOf(key);
        if (idx < 0) return null;
        const colon = text.indexOf(":", idx + key.length);
        const start = text.indexOf("{", colon);
        if (start < 0) return null;
        let depth = 0, inString = false, esc = false;
        for (let i = start; i < text.length; i++) {
          const ch = text[i];
          if (inString) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') inString = false;
          } else {
            if (ch === '"') inString = true;
            else if (ch === "{") depth++;
            else if (ch === "}") {
              depth--;
              if (depth === 0) return text.slice(start, i + 1);
            }
          }
        }
        return null;
      }

      function extractJobMap() {
        const sources = [];
        if (Array.isArray(window.__next_f)) {
          for (const row of window.__next_f) {
            if (Array.isArray(row)) {
              for (const part of row) if (typeof part === "string") sources.push(part);
            }
          }
        }
        for (const s of document.scripts) sources.push(s.textContent || "");

        for (const raw of sources) {
          if (!raw.includes("jobKeysMap")) continue;
          const variants = [
            raw,
            raw.replace(/\\"/g, '"').replace(/\\u0026/g, "&").replace(/\\n/g, "\n")
          ];
          for (const text of variants) {
            const objText = balancedObject(text, '"jobKeysMap"');
            if (!objText) continue;
            try {
              const obj = JSON.parse(objText);
              if (obj && typeof obj === "object" && Object.keys(obj).length) return obj;
            } catch (e) {}
          }
        }
        return null;
      }

      const jobMap = extractJobMap();
      if (jobMap) {
        return Object.values(jobMap).map(job => {
          const display = job.display || {};
          const locTypes = display.locationTypesV2?.fullDisplay || display.locationTypesV2?.compactDisplay || display.locationTypes || "";
          let loc = clean(display.location) || clean(job.location?.displayName);
          if (!loc && /remote/i.test(locTypes)) loc = "Remote";

          let employment = clean(display.employmentTypes?.fullDisplay) || clean(display.employmentTypes?.compactDisplay);
          if (!employment && Array.isArray(job.employmentTypes)) {
            employment = clean(job.employmentTypes.map(e => employmentName(e && e.name)).filter(Boolean).join(", "));
          }

          return {
            title: clean(job.title),
            company: clean(job.company && job.company.name),
            location: loc,
            url: absolute(job.rawCanonicalZipJobPageUrl || job.seoJobRedirectPageUrl || job.jobRedirectPageUrl),
            employmentType: employment,
            postedAt: clean(display.rollingPostedAt)
          };
        }).filter(r => r.title && r.company && r.url);
      }

      // Fallback: listing cards plus the ItemList JSON-LD contains canonical URLs.
      let ldUrls = [];
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(s.textContent || "{}");
          const items = Array.isArray(data.itemListElement) ? data.itemListElement : [];
          if (items.length) ldUrls = items.map(x => x && x.url).filter(Boolean);
        } catch (e) {}
      }
      const ids = new Set();
      const cards = [];
      for (const el of document.querySelectorAll('article[id^="job-card-"]')) {
        if (ids.has(el.id)) continue;
        ids.add(el.id);
        cards.push(el);
      }
      return cards.map((el, i) => ({
        title: clean(el.querySelector('[data-testid="serp-job-card-title"], h2')?.textContent),
        company: clean(el.querySelector('[data-testid="job-card-company"]')?.textContent),
        location: clean(el.querySelector('[data-testid="job-card-location"]')?.textContent),
        url: absolute(ldUrls[i]),
        employmentType: null,
        postedAt: null
      })).filter(r => r.title && r.company && r.url);
    });

    if (!pageRecords.length) break;
    for (const r of pageRecords) {
      if (!r.title || !r.company || !r.url) continue;
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      results.push({
        title: r.title,
        company: r.company,
        location: r.location || null,
        url: r.url,
        employmentType: r.employmentType || null,
        postedAt: r.postedAt || null
      });
      if (results.length >= limit) break;
    }
  }

  return results.slice(0, limit);
}
