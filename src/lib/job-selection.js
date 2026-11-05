// Which jobs the popup offers and which one it preselects. Pure functions, no browser APIs.
import { hasTrigger, matchesTrigger } from './extract.js';

// Jobs bound to this website + jobs without URL (manual). Jobs of other sites are hidden.
export function availableJobs(jobs, url) {
  return {
    matched: jobs.filter(job => matchesTrigger(job.trigger, url)),
    manual: jobs.filter(job => !hasTrigger(job.trigger))
  };
}

// Matching job first; otherwise the default job (if it is a manual one); else first manual.
export function pickInitialJob({ matched, manual }, defaultJobId) {
  return matched[0] ?? manual.find(job => job.id === defaultJobId) ?? manual[0] ?? null;
}

// Saved manual texts win over extracted values; jobs bound to a site always use fresh page data.
export function initialValues(job, extracted, saved) {
  return hasTrigger(job.trigger) ? extracted : { ...extracted, ...saved };
}

// ☆/★ toggle: only manual jobs can be the default; clicking the current default removes it.
export function toggledDefaultJobId(currentDefaultId, job) {
  if (hasTrigger(job.trigger)) return currentDefaultId;
  return currentDefaultId === job.id ? '' : job.id;
}
