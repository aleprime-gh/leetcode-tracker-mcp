import type { SolvedCounts } from "./domain.js";

const BASE_URL = "https://leetcode.com";
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 1_000;

export class LeetCodeError extends Error {}

export interface TopicCount {
  name: string;
  slug: string;
  level: "fundamental" | "intermediate" | "advanced";
  solved: number;
}

export interface Profile {
  username: string;
  ranking: number | null;
  solved: SolvedCounts;
  totals: SolvedCounts;
  topics: TopicCount[];
  calendar: Record<string, number>;
  bestStreak: number;
  totalActiveDays: number;
}

export interface Question {
  frontendId: string;
  title: string;
  slug: string;
  difficulty: string;
  topics: string[];
  paidOnly: boolean;
}

export interface Submission {
  id: string;
  title: string;
  slug: string;
  timestamp: number;
  accepted: boolean;
  lang?: string;
}

export interface SubmissionPage {
  submissions: Submission[];
  hasNext: boolean;
  lastKey: string;
}

export interface DailyChallenge {
  date: string;
  question: Question;
}

export interface LeetCodeApi {
  readonly hasSession: boolean;
  getProfile(username: string): Promise<Profile | null>;
  getRecentAccepted(username: string, limit: number): Promise<Submission[]>;
  getSubmissionPage(offset: number, lastKey: string): Promise<SubmissionPage>;
  getQuestion(slug: string): Promise<Question | null>;
  getDaily(): Promise<DailyChallenge>;
}

const QUESTION_FIELDS = `
  questionFrontendId title titleSlug difficulty isPaidOnly
  topicTags { slug }
`;

const PROFILE_QUERY = `
query profile($username: String!) {
  allQuestionsCount { difficulty count }
  matchedUser(username: $username) {
    username
    profile { ranking }
    submitStatsGlobal { acSubmissionNum { difficulty count } }
    tagProblemCounts {
      fundamental { tagName tagSlug problemsSolved }
      intermediate { tagName tagSlug problemsSolved }
      advanced { tagName tagSlug problemsSolved }
    }
    userCalendar { streak totalActiveDays submissionCalendar }
  }
}`;

const RECENT_QUERY = `
query recent($username: String!, $limit: Int!) {
  recentAcSubmissionList(username: $username, limit: $limit) {
    id title titleSlug timestamp lang
  }
}`;

const QUESTION_QUERY = `
query question($slug: String!) {
  question(titleSlug: $slug) { ${QUESTION_FIELDS} }
}`;

const DAILY_QUERY = `
query daily {
  activeDailyCodingChallengeQuestion {
    date
    question { ${QUESTION_FIELDS} }
  }
}`;

interface RawQuestion {
  questionFrontendId: string;
  title: string;
  titleSlug: string;
  difficulty: string;
  isPaidOnly: boolean;
  topicTags: { slug: string }[];
}

function toQuestion(raw: RawQuestion): Question {
  return {
    frontendId: raw.questionFrontendId,
    title: raw.title,
    slug: raw.titleSlug,
    difficulty: raw.difficulty,
    paidOnly: raw.isPaidOnly,
    topics: raw.topicTags.map((tag) => tag.slug),
  };
}

function toCounts(rows: { difficulty: string; count: number }[]): SolvedCounts {
  const find = (name: string) => rows.find((row) => row.difficulty === name)?.count ?? 0;
  return { all: find("All"), easy: find("Easy"), medium: find("Medium"), hard: find("Hard") };
}

export interface ClientOptions {
  session?: string;
  csrfToken?: string;
  fetch?: typeof fetch;
  retryDelayMs?: number;
}

export class LeetCodeClient implements LeetCodeApi {
  private readonly session?: string;
  private readonly csrfToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(options: ClientOptions = {}) {
    this.session = options.session || undefined;
    this.csrfToken = options.csrfToken || undefined;
    this.fetchImpl = options.fetch ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  }

  get hasSession(): boolean {
    return this.session !== undefined;
  }

  private headers(authenticated: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Referer: `${BASE_URL}/`,
      "User-Agent": "Mozilla/5.0 (compatible; leetcode-tracker-mcp)",
    };
    if (authenticated && this.session) {
      const csrf = this.csrfToken ? `; csrftoken=${this.csrfToken}` : "";
      headers.Cookie = `LEETCODE_SESSION=${this.session}${csrf}`;
      if (this.csrfToken) headers["x-csrftoken"] = this.csrfToken;
    }
    return headers;
  }

  /** Retries once on rate limiting and server errors. */
  private async request(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
          continue;
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new LeetCodeError(`Could not reach LeetCode: ${reason}`);
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
        continue;
      }
      return response;
    }
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.request(`${BASE_URL}/graphql`, {
      method: "POST",
      headers: this.headers(false),
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new LeetCodeError(`LeetCode responded with HTTP ${response.status}`);
    }
    const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (!body.data) {
      const reason = body.errors?.map((error) => error.message).join("; ") ?? "empty response";
      throw new LeetCodeError(`LeetCode GraphQL error: ${reason}`);
    }
    return body.data;
  }

  async getProfile(username: string): Promise<Profile | null> {
    type Tag = { tagName: string; tagSlug: string; problemsSolved: number };
    const data = await this.graphql<{
      allQuestionsCount: { difficulty: string; count: number }[];
      matchedUser: {
        username: string;
        profile: { ranking: number | null };
        submitStatsGlobal: { acSubmissionNum: { difficulty: string; count: number }[] };
        tagProblemCounts: Record<TopicCount["level"], Tag[]>;
        userCalendar: {
          streak: number;
          totalActiveDays: number;
          submissionCalendar: string;
        } | null;
      } | null;
    }>(PROFILE_QUERY, { username });

    const user = data.matchedUser;
    if (!user) return null;
    const levels = ["fundamental", "intermediate", "advanced"] as const;
    return {
      username: user.username,
      ranking: user.profile.ranking,
      solved: toCounts(user.submitStatsGlobal.acSubmissionNum),
      totals: toCounts(data.allQuestionsCount),
      topics: levels.flatMap((level) =>
        user.tagProblemCounts[level].map((tag) => ({
          name: tag.tagName,
          slug: tag.tagSlug,
          level,
          solved: tag.problemsSolved,
        })),
      ),
      calendar: JSON.parse(user.userCalendar?.submissionCalendar ?? "{}"),
      bestStreak: user.userCalendar?.streak ?? 0,
      totalActiveDays: user.userCalendar?.totalActiveDays ?? 0,
    };
  }

  async getRecentAccepted(username: string, limit: number): Promise<Submission[]> {
    const data = await this.graphql<{
      recentAcSubmissionList: {
        id: string;
        title: string;
        titleSlug: string;
        timestamp: string;
        lang?: string;
      }[] | null;
    }>(RECENT_QUERY, { username, limit });
    return (data.recentAcSubmissionList ?? []).map((row) => ({
      id: String(row.id),
      title: row.title,
      slug: row.titleSlug,
      timestamp: Number(row.timestamp),
      accepted: true,
      lang: row.lang,
    }));
  }

  async getSubmissionPage(offset: number, lastKey: string): Promise<SubmissionPage> {
    if (!this.session) {
      throw new LeetCodeError("Full history import requires LEETCODE_SESSION to be set.");
    }
    const params = new URLSearchParams({ offset: String(offset), limit: "20", lastkey: lastKey });
    const response = await this.request(`${BASE_URL}/api/submissions/?${params}`, {
      method: "GET",
      headers: this.headers(true),
      redirect: "manual",
    });
    const expired = "LeetCode rejected the session. Refresh LEETCODE_SESSION and LEETCODE_CSRF_TOKEN.";
    if (response.status === 401 || response.status === 403 || response.status === 302) {
      throw new LeetCodeError(expired);
    }
    if (!response.ok) {
      throw new LeetCodeError(`LeetCode responded with HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      submissions_dump?: {
        id: number | string;
        title: string;
        title_slug: string;
        timestamp: number | string;
        status_display: string;
        lang?: string;
      }[];
      has_next?: boolean;
      last_key?: string;
    };
    if (!Array.isArray(body.submissions_dump)) throw new LeetCodeError(expired);
    return {
      submissions: body.submissions_dump.map((row) => ({
        id: String(row.id),
        title: row.title,
        slug: row.title_slug,
        timestamp: Number(row.timestamp),
        accepted: row.status_display === "Accepted",
        lang: row.lang,
      })),
      hasNext: body.has_next === true,
      lastKey: body.last_key ?? "",
    };
  }

  async getQuestion(slug: string): Promise<Question | null> {
    const data = await this.graphql<{ question: RawQuestion | null }>(QUESTION_QUERY, { slug });
    return data.question ? toQuestion(data.question) : null;
  }

  async getDaily(): Promise<DailyChallenge> {
    const data = await this.graphql<{
      activeDailyCodingChallengeQuestion: { date: string; question: RawQuestion };
    }>(DAILY_QUERY, {});
    const daily = data.activeDailyCodingChallengeQuestion;
    return { date: daily.date, question: toQuestion(daily.question) };
  }
}
