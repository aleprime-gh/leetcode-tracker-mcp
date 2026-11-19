import {
  addDays,
  type Confidence,
  daysBetween,
  type GoalMetric,
  goalStatus,
  isValidDay,
  normalizeSlug,
  scheduleReview,
  type SolvedCounts,
  summarizeActivity,
  utcDate,
} from "./domain.js";
import { type LeetCodeApi, LeetCodeError, type Profile, type Question, type Submission } from "./leetcode.js";
import type { Attempt, ProblemRecord, Store, TrackerState } from "./store.js";

const RECENT_LIMIT = 20;
const MAX_HISTORY_PAGES_PER_CALL = 20;
const MAX_METADATA_PER_CALL = 40;
/** Older submissions are imported as history without flooding the review queue. */
const AUTO_REVIEW_WINDOW_DAYS = 14;

export class UserInputError extends Error {}

export interface TrackerOptions {
  defaultUsername?: string;
  now?: () => Date;
  requestDelayMs?: number;
}

const problemUrl = (slug: string) => `https://leetcode.com/problems/${slug}/`;
const isSolved = (problem: ProblemRecord) => problem.attempts.some((attempt) => attempt.accepted);

function newRecord(slug: string, title: string): ProblemRecord {
  return { slug, title, topics: [], metadataLoaded: false, attempts: [], review: null };
}

function applyMetadata(record: ProblemRecord, question: Question): void {
  record.title = question.title;
  record.frontendId = question.frontendId;
  record.difficulty = question.difficulty;
  record.topics = question.topics;
  record.metadataLoaded = true;
}

function summarizeProblem(problem: ProblemRecord) {
  return {
    slug: problem.slug,
    id: problem.frontendId,
    title: problem.title,
    difficulty: problem.difficulty,
    topics: problem.topics,
    url: problemUrl(problem.slug),
    solved: isSolved(problem),
    attempts: problem.attempts.length,
    lastAttemptAt: problem.attempts.at(-1)?.at ?? null,
    reviewDueAt: problem.review?.dueAt ?? null,
  };
}

export class Tracker {
  private readonly now: () => Date;
  private readonly requestDelayMs: number;

  constructor(
    private readonly api: LeetCodeApi,
    private readonly store: Store,
    private readonly options: TrackerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.requestDelayMs = options.requestDelayMs ?? 300;
  }

  private resolveUsername(username?: string): string {
    const resolved = username?.trim() || this.options.defaultUsername?.trim();
    if (!resolved) {
      throw new UserInputError("Pass a username or set the LEETCODE_USERNAME environment variable.");
    }
    return resolved;
  }

  private async requireProfile(username?: string): Promise<Profile> {
    const resolved = this.resolveUsername(username);
    const profile = await this.api.getProfile(resolved);
    if (!profile) throw new UserInputError(`LeetCode user "${resolved}" was not found.`);
    return profile;
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.requestDelayMs));
  }

  private applySubmissions(state: TrackerState, submissions: Submission[]) {
    const known = new Set(
      Object.values(state.problems).flatMap((problem) =>
        problem.attempts.flatMap((attempt) => attempt.submissionId ?? []),
      ),
    );
    const today = utcDate(this.now());
    const newlySolved: string[] = [];
    let imported = 0;

    for (const submission of [...submissions].sort((a, b) => a.timestamp - b.timestamp)) {
      if (known.has(submission.id)) continue;
      known.add(submission.id);
      imported += 1;

      const record = (state.problems[submission.slug] ??= newRecord(submission.slug, submission.title));
      const wasSolved = isSolved(record);
      const at = new Date(submission.timestamp * 1000);
      record.attempts.push({
        at: at.toISOString(),
        source: "leetcode",
        accepted: submission.accepted,
        submissionId: submission.id,
        lang: submission.lang,
      });
      record.attempts.sort((a, b) => a.at.localeCompare(b.at));
      if (submission.accepted && !wasSolved) newlySolved.push(submission.slug);

      const recent = daysBetween(utcDate(at), today) <= AUTO_REVIEW_WINDOW_DAYS;
      const reviewIsDue = !record.review || utcDate(at) >= record.review.dueAt;
      if (submission.accepted && recent && reviewIsDue) {
        record.review = scheduleReview(record.review, 3, at);
      }
    }
    return { imported, newlySolved };
  }

  private async fetchHistory(): Promise<{ submissions: Submission[]; complete: boolean }> {
    if (!this.api.hasSession) {
      throw new UserInputError("full_history requires LEETCODE_SESSION in the server environment.");
    }
    const cursor = await this.store.read((state) => state.importCursor);
    let offset = cursor?.offset ?? 0;
    let lastKey = cursor?.lastKey ?? "";
    const submissions: Submission[] = [];

    for (let page = 0; page < MAX_HISTORY_PAGES_PER_CALL; page += 1) {
      if (page > 0) await this.pause();
      const result = await this.api.getSubmissionPage(offset, lastKey);
      submissions.push(...result.submissions);
      offset += result.submissions.length;
      lastKey = result.lastKey;
      if (!result.hasNext) {
        await this.store.update((state) => void (state.importCursor = null));
        return { submissions, complete: true };
      }
    }
    await this.store.update((state) => void (state.importCursor = { offset, lastKey }));
    return { submissions, complete: false };
  }

  private async loadMissingMetadata(): Promise<number> {
    const slugs = await this.store.read((state) =>
      Object.values(state.problems)
        .filter((problem) => !problem.metadataLoaded)
        .map((problem) => problem.slug),
    );
    for (const slug of slugs.slice(0, MAX_METADATA_PER_CALL)) {
      const question = await this.api.getQuestion(slug);
      await this.store.update((state) => {
        const record = state.problems[slug];
        if (!record) return;
        if (question) applyMetadata(record, question);
        else record.metadataLoaded = true;
      });
      await this.pause();
    }
    return Math.max(0, slugs.length - MAX_METADATA_PER_CALL);
  }

  async sync(input: { username?: string; fullHistory?: boolean }) {
    const profile = await this.requireProfile(input.username);
    const history = input.fullHistory ? await this.fetchHistory() : null;
    const submissions =
      history?.submissions ?? (await this.api.getRecentAccepted(profile.username, RECENT_LIMIT));

    const now = this.now();
    const result = await this.store.update((state) => {
      const applied = this.applySubmissions(state, submissions);
      const date = utcDate(now);
      state.snapshots = state.snapshots.filter((snapshot) => snapshot.date !== date);
      state.snapshots.push({ date, solved: profile.solved });
      state.lastSyncAt = now.toISOString();
      return applied;
    });
    const metadataPending = await this.loadMissingMetadata();

    return {
      username: profile.username,
      solved: profile.solved,
      submissionsFetched: submissions.length,
      newAttemptsImported: result.imported,
      newlySolved: result.newlySolved,
      historyComplete: history?.complete ?? null,
      metadataPending,
      hint:
        history && !history.complete
          ? "Call sync_progress with full_history again to continue the import."
          : metadataPending > 0
            ? "Call sync_progress again to load the remaining problem details."
            : undefined,
    };
  }

  async getProgress(input: { username?: string }) {
    const profile = await this.requireProfile(input.username);
    const now = this.now();
    const today = utcDate(now);
    const local = await this.store.read((state) => {
      const delta = (days: number): SolvedCounts | null => {
        const cutoff = addDays(today, -days);
        const base = state.snapshots.filter((snapshot) => snapshot.date <= cutoff).at(-1);
        if (!base) return null;
        return {
          all: profile.solved.all - base.solved.all,
          easy: profile.solved.easy - base.solved.easy,
          medium: profile.solved.medium - base.solved.medium,
          hard: profile.solved.hard - base.solved.hard,
        };
      };
      return {
        solvedLast7Days: delta(7),
        solvedLast30Days: delta(30),
        goals: Object.values(state.goals).map((goal) => goalStatus(goal, profile.solved, now)),
        reviewsDue: Object.values(state.problems).filter(
          (problem) => problem.review && problem.review.dueAt <= today,
        ).length,
        trackedProblems: Object.keys(state.problems).length,
        lastSyncAt: state.lastSyncAt,
      };
    });

    const percent = (metric: GoalMetric) =>
      profile.totals[metric] === 0
        ? 0
        : Math.round((profile.solved[metric] / profile.totals[metric]) * 1000) / 10;

    return {
      username: profile.username,
      ranking: profile.ranking,
      solved: profile.solved,
      totalAvailable: profile.totals,
      percentSolved: {
        all: percent("all"),
        easy: percent("easy"),
        medium: percent("medium"),
        hard: percent("hard"),
      },
      activity: {
        ...summarizeActivity(profile.calendar, now),
        bestStreak: profile.bestStreak,
        totalActiveDays: profile.totalActiveDays,
      },
      ...local,
    };
  }

  async logAttempt(input: {
    problem: string;
    accepted: boolean;
    minutes?: number;
    confidence?: Confidence;
    note?: string;
  }) {
    const slug = normalizeSlug(input.problem);
    const known = await this.store.read((state) => state.problems[slug]?.metadataLoaded === true);
    let question: Question | null = null;
    if (!known) {
      try {
        question = await this.api.getQuestion(slug);
        if (!question) throw new UserInputError(`Problem "${slug}" was not found on LeetCode.`);
      } catch (error) {
        // Offline logging still works. The next sync fills in the problem details.
        if (!(error instanceof LeetCodeError)) throw error;
      }
    }

    const now = this.now();
    const confidence = input.confidence ?? (input.accepted ? 3 : 1);
    return this.store.update((state) => {
      const record = (state.problems[slug] ??= newRecord(slug, slug));
      if (question) applyMetadata(record, question);
      const attempt: Attempt = {
        at: now.toISOString(),
        source: "manual",
        accepted: input.accepted,
        confidence,
        minutes: input.minutes,
        note: input.note,
      };
      record.attempts.push(attempt);
      record.review = scheduleReview(record.review, confidence, now);
      return { ...summarizeProblem(record), nextReview: record.review };
    });
  }

  async getProblemHistory(input: { problem: string }) {
    const slug = normalizeSlug(input.problem);
    const record = await this.store.read((state) => state.problems[slug]);
    if (record) {
      return { ...summarizeProblem(record), review: record.review, history: record.attempts };
    }
    const question = await this.api.getQuestion(slug);
    if (!question) throw new UserInputError(`Problem "${slug}" was not found on LeetCode.`);
    return { ...question, url: problemUrl(slug), solved: false, attempts: 0, history: [] };
  }

  listProblems(input: {
    status?: "solved" | "unsolved";
    difficulty?: "Easy" | "Medium" | "Hard";
    topic?: string;
    limit?: number;
  }) {
    const topic = input.topic?.trim().toLowerCase().replace(/\s+/g, "-");
    return this.store.read((state) => {
      const matches = Object.values(state.problems)
        .filter((problem) => !input.status || isSolved(problem) === (input.status === "solved"))
        .filter((problem) => !input.difficulty || problem.difficulty === input.difficulty)
        .filter((problem) => !topic || problem.topics.includes(topic))
        .map(summarizeProblem)
        .sort((a, b) => (b.lastAttemptAt ?? "").localeCompare(a.lastAttemptAt ?? ""));
      return { total: matches.length, problems: matches.slice(0, input.limit ?? 50) };
    });
  }

  getDueReviews(input: { limit?: number; upcomingDays?: number }) {
    const today = utcDate(this.now());
    const horizon = addDays(today, input.upcomingDays ?? 0);
    return this.store.read((state) => {
      const scheduled = Object.values(state.problems)
        .filter((problem) => problem.review)
        .map((problem) => ({
          slug: problem.slug,
          title: problem.title,
          difficulty: problem.difficulty,
          url: problemUrl(problem.slug),
          dueAt: problem.review!.dueAt,
          overdueDays: Math.max(0, daysBetween(problem.review!.dueAt, today)),
          intervalDays: problem.review!.intervalDays,
          lastConfidence: problem.review!.lastConfidence,
        }))
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
      const due = scheduled.filter((item) => item.dueAt <= today);
      return {
        today,
        dueCount: due.length,
        due: due.slice(0, input.limit ?? 10),
        upcoming: scheduled.filter((item) => item.dueAt > today && item.dueAt <= horizon),
      };
    });
  }

  async analyzeTopics(input: { username?: string; limit?: number }) {
    const profile = await this.requireProfile(input.username);
    const limit = input.limit ?? 5;
    const struggling = await this.store.read((state) => {
      const byTopic = new Map<string, { attempts: number; failed: number; ratings: number[] }>();
      for (const problem of Object.values(state.problems)) {
        for (const topic of problem.topics) {
          const stats = byTopic.get(topic) ?? { attempts: 0, failed: 0, ratings: [] };
          for (const attempt of problem.attempts) {
            stats.attempts += 1;
            if (!attempt.accepted) stats.failed += 1;
            if (attempt.confidence) stats.ratings.push(attempt.confidence);
          }
          byTopic.set(topic, stats);
        }
      }
      return [...byTopic.entries()]
        .filter(([, stats]) => stats.attempts >= 3 && stats.failed > 0)
        .map(([topic, stats]) => ({
          topic,
          attempts: stats.attempts,
          failRatePercent: Math.round((stats.failed / stats.attempts) * 100),
          averageConfidence: stats.ratings.length
            ? Math.round((stats.ratings.reduce((sum, value) => sum + value, 0) / stats.ratings.length) * 10) / 10
            : null,
        }))
        .sort((a, b) => b.failRatePercent - a.failRatePercent)
        .slice(0, limit);
    });

    const leastPracticed = (level: Profile["topics"][number]["level"]) =>
      profile.topics
        .filter((topic) => topic.level === level)
        .sort((a, b) => a.solved - b.solved)
        .slice(0, limit)
        .map(({ name, slug, solved }) => ({ name, slug, solved }));

    return {
      username: profile.username,
      leastPracticed: {
        fundamental: leastPracticed("fundamental"),
        intermediate: leastPracticed("intermediate"),
        advanced: leastPracticed("advanced"),
      },
      mostPracticed: [...profile.topics]
        .sort((a, b) => b.solved - a.solved)
        .slice(0, limit)
        .map(({ name, slug, solved }) => ({ name, slug, solved })),
      struggling,
    };
  }

  async setGoal(input: { metric: GoalMetric; target: number; deadline?: string }) {
    if (input.deadline && !isValidDay(input.deadline)) {
      throw new UserInputError("deadline must be a real date in YYYY-MM-DD format.");
    }
    return this.store.update((state) => {
      if (input.target === 0) delete state.goals[input.metric];
      else state.goals[input.metric] = { ...input };
      return { goals: Object.values(state.goals) };
    });
  }

  async getDailyChallenge() {
    const daily = await this.api.getDaily();
    const record = await this.store.read((state) => state.problems[daily.question.slug]);
    return {
      date: daily.date,
      ...daily.question,
      url: problemUrl(daily.question.slug),
      solvedBefore: record ? isSolved(record) : false,
      attempts: record?.attempts.length ?? 0,
    };
  }
}
