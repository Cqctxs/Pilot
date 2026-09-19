/**
 * A small synthetic catalogue. Deliberately includes the shapes that break
 * naive extractors: a missing location, a job whose type only appears in the
 * title, and two postings that differ only by location.
 */
export interface TestJob {
  id: string;
  title: string;
  company: string;
  location: string | null;
  employmentType: string | null;
  postedAt: string;
}

export const TEST_JOBS: readonly TestJob[] = [
  { id: "1", title: "Software Engineering Intern", company: "Pilot Labs", location: "Cambridge, MA", employmentType: "Internship", postedAt: "2026-09-02" },
  { id: "2", title: "Software Engineer", company: "Harbor Robotics", location: "Boston, MA", employmentType: "Full time", postedAt: "2026-09-04" },
  { id: "3", title: "Data Science Intern", company: "Pilot Labs", location: "Toronto, ON", employmentType: "Internship", postedAt: "2026-09-05" },
  { id: "4", title: "Backend Engineer", company: "Meridian Health", location: "Remote", employmentType: "Full time", postedAt: "2026-09-07" },
  { id: "5", title: "Product Design Intern", company: "Harbor Robotics", location: "Boston, MA", employmentType: null, postedAt: "2026-09-08" },
  { id: "6", title: "Site Reliability Engineer", company: "Meridian Health", location: "Austin, TX", employmentType: "Full time", postedAt: "2026-09-09" },
  { id: "7", title: "Machine Learning Intern (Summer)", company: "Northwind Analytics", location: null, employmentType: null, postedAt: "2026-09-11" },
  { id: "8", title: "Software Engineer", company: "Harbor Robotics", location: "New York, NY", employmentType: "Part time", postedAt: "2026-09-12" },
];

export function searchJobs(keywords: string, location: string): TestJob[] {
  const terms = keywords.toLowerCase().split(/\s+/).filter(Boolean);
  const place = location.toLowerCase().trim();
  return TEST_JOBS.filter((job) => {
    const haystack = `${job.title} ${job.company}`.toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) return false;
    if (place && !(job.location ?? "").toLowerCase().includes(place)) return false;
    return true;
  });
}
