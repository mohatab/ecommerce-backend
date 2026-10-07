/**
 * What every maintenance job reports back to the runner.
 *
 * Four numbers, deliberately uniform across the three jobs so the runner can
 * spread them into a summary without knowing which job produced them:
 *
 *   examined — rows the job looked at this tick
 *   affected — rows it actually changed
 *   skipped  — rows it deliberately left alone (not eligible, vetoed, raced)
 *   failed   — rows it could not process; retried on the next tick, never
 *              within this one (spec §9.4)
 *
 * `skipped` and `failed` are separate because they mean opposite things
 * operationally: a steady `skipped` is the system working, a steady `failed`
 * is an incident.
 */
export interface JobCounts {
  examined: number;
  affected: number;
  skipped: number;
  failed: number;
}

/** A tick that did no work. Frozen: it is shared by every caller. */
export const NO_WORK: Readonly<JobCounts> = Object.freeze({
  examined: 0,
  affected: 0,
  skipped: 0,
  failed: 0,
});
