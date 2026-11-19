/** Pure tracking rules. All calendar days are UTC, matching LeetCode's day boundary. */

export type Confidence = 1 | 2 | 3 | 4 | 5;
export type GoalMetric = "all" | "easy" | "medium" | "hard";
export type SolvedCounts = Record<GoalMetric, number>;

export interface Review {
  intervalDays: number;
  dueAt: string;
  reps: number;
  lastConfidence: Confidence;
  lastReviewedAt: string;
}

export interface Goal {
  metric: GoalMetric;
  target: number;
  deadline?: string;
}

const DAY_MS = 86_400_000;
const MAX_INTERVAL_DAYS = 180;

export function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return utcDate(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function isValidDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed) && utcDate(new Date(parsed)) === day;
}

export function nextIntervalDays(previous: number, confidence: Confidence): number {
  if (confidence <= 2) return 1;
  const [minimum, factor] =
    confidence === 3 ? [2, 1.5] : confidence === 4 ? [4, 2.5] : [7, 3.5];
  return Math.min(MAX_INTERVAL_DAYS, Math.max(minimum, Math.round(previous * factor)));
}

export function scheduleReview(previous: Review | null, confidence: Confidence, at: Date): Review {
  const intervalDays = nextIntervalDays(previous?.intervalDays ?? 0, confidence);
  return {
    intervalDays,
    dueAt: addDays(utcDate(at), intervalDays),
    reps: confidence <= 2 ? 0 : (previous?.reps ?? 0) + 1,
    lastConfidence: confidence,
    lastReviewedAt: at.toISOString(),
  };
}

export interface ActivitySummary {
  currentStreak: number;
  activeDaysLast30: number;
  submissionsLast7: number;
  submissionsLast30: number;
}

/** `calendar` is LeetCode's map of UTC-midnight unix seconds to submission counts. */
export function summarizeActivity(calendar: Record<string, number>, now: Date): ActivitySummary {
  const byDay = new Map<string, number>();
  for (const [seconds, count] of Object.entries(calendar)) {
    const day = utcDate(new Date(Number(seconds) * 1000));
    byDay.set(day, (byDay.get(day) ?? 0) + count);
  }

  const today = utcDate(now);
  // A streak is still alive today if the user was active yesterday.
  let cursor = (byDay.get(today) ?? 0) > 0 ? today : addDays(today, -1);
  let currentStreak = 0;
  while ((byDay.get(cursor) ?? 0) > 0) {
    currentStreak += 1;
    cursor = addDays(cursor, -1);
  }

  let activeDaysLast30 = 0;
  let submissionsLast7 = 0;
  let submissionsLast30 = 0;
  for (let offset = 0; offset < 30; offset += 1) {
    const count = byDay.get(addDays(today, -offset)) ?? 0;
    if (count > 0) activeDaysLast30 += 1;
    submissionsLast30 += count;
    if (offset < 7) submissionsLast7 += count;
  }
  return { currentStreak, activeDaysLast30, submissionsLast7, submissionsLast30 };
}

export function goalStatus(goal: Goal, solved: SolvedCounts, now: Date) {
  const current = solved[goal.metric];
  const remaining = Math.max(0, goal.target - current);
  const achieved = remaining === 0;
  // The deadline day itself is still usable, so the range is inclusive.
  const daysLeft = goal.deadline
    ? Math.max(0, daysBetween(utcDate(now), goal.deadline) + 1)
    : null;
  return {
    ...goal,
    current,
    remaining,
    achieved,
    daysLeft,
    overdue: !achieved && daysLeft === 0,
    requiredPerDay:
      !achieved && daysLeft ? Math.ceil((remaining / daysLeft) * 100) / 100 : null,
  };
}

/** Accepts a slug or any leetcode.com problem URL. */
export function normalizeSlug(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const fromUrl = trimmed.match(/\/problems\/([^/?#]+)/)?.[1];
  return fromUrl ?? trimmed.replace(/^\/+|\/+$/g, "");
}
