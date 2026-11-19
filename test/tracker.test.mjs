import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  goalStatus,
  isValidDay,
  nextIntervalDays,
  normalizeSlug,
  summarizeActivity,
} from "../dist/domain.js";
import { LeetCodeClient } from "../dist/leetcode.js";
import { Store } from "../dist/store.js";
import { Tracker, UserInputError } from "../dist/tracker.js";

const NOW = new Date("2026-11-18T12:00:00Z");
const seconds = (iso) => Date.parse(iso) / 1000;

const question = (slug, topics = ["array"]) => ({
  frontendId: "1",
  title: slug.toUpperCase(),
  slug,
  difficulty: "Easy",
  topics,
  paidOnly: false,
});

const submission = (id, slug, iso, accepted = true) => ({
  id,
  title: slug,
  slug,
  timestamp: seconds(iso),
  accepted,
});

function fakeApi(overrides = {}) {
  return {
    hasSession: false,
    getProfile: async (username) =>
      username === "ghost"
        ? null
        : {
            username,
            ranking: 100,
            solved: { all: 10, easy: 5, medium: 4, hard: 1 },
            totals: { all: 100, easy: 50, medium: 40, hard: 10 },
            topics: [
              { name: "Array", slug: "array", level: "fundamental", solved: 9 },
              { name: "Sorting", slug: "sorting", level: "fundamental", solved: 1 },
            ],
            calendar: {},
            bestStreak: 3,
            totalActiveDays: 5,
          },
    getRecentAccepted: async () => [],
    getSubmissionPage: async () => ({ submissions: [], hasNext: false, lastKey: "" }),
    getQuestion: async (slug) => (slug === "missing" ? null : question(slug)),
    getDaily: async () => ({ date: "2026-11-18", question: question("two-sum") }),
    ...overrides,
  };
}

describe("domain rules", () => {
  it("grows intervals with confidence and resets on low confidence", () => {
    assert.equal(nextIntervalDays(30, 1), 1);
    assert.equal(nextIntervalDays(0, 3), 2);
    assert.equal(nextIntervalDays(4, 4), 10);
    assert.equal(nextIntervalDays(100, 5), 180);
  });

  it("keeps a streak alive until the end of the following day", () => {
    const day = (iso) => String(seconds(`${iso}T00:00:00Z`));
    const calendar = { [day("2026-11-17")]: 2, [day("2026-11-16")]: 1, [day("2026-11-14")]: 4 };
    const summary = summarizeActivity(calendar, NOW);
    assert.equal(summary.currentStreak, 2);
    assert.equal(summary.submissionsLast7, 7);
    assert.equal(summarizeActivity({ [day("2026-11-15")]: 1 }, NOW).currentStreak, 0);
  });

  it("computes the pace needed for a goal, counting the deadline day", () => {
    const solved = { all: 10, easy: 5, medium: 4, hard: 1 };
    const status = goalStatus({ metric: "all", target: 20, deadline: "2026-11-22" }, solved, NOW);
    assert.equal(status.daysLeft, 5);
    assert.equal(status.requiredPerDay, 2);
    assert.equal(goalStatus({ metric: "all", target: 20, deadline: "2026-11-01" }, solved, NOW).overdue, true);
    assert.equal(goalStatus({ metric: "all", target: 5 }, solved, NOW).achieved, true);
  });

  it("normalizes slugs and rejects impossible dates", () => {
    assert.equal(normalizeSlug("https://leetcode.com/problems/Two-Sum/description/?x=1"), "two-sum");
    assert.equal(normalizeSlug(" two-sum/ "), "two-sum");
    assert.equal(isValidDay("2026-02-30"), false);
    assert.equal(isValidDay("2026-02-28"), true);
  });
});

describe("tracker", () => {
  let directory;
  let path;
  const build = (api = fakeApi()) =>
    new Tracker(api, new Store(path), {
      defaultUsername: "me",
      now: () => NOW,
      requestDelayMs: 0,
    });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lc-tracker-"));
    path = join(directory, "nested", "data.json");
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it("imports submissions once across repeated syncs", async () => {
    const api = fakeApi({
      getRecentAccepted: async () => [submission("1", "two-sum", "2026-11-17T10:00:00Z")],
    });
    const tracker = build(api);
    const first = await tracker.sync({});
    const second = await tracker.sync({});
    assert.deepEqual(first.newlySolved, ["two-sum"]);
    assert.equal(second.newAttemptsImported, 0);
    const listed = await tracker.listProblems({ status: "solved" });
    assert.equal(listed.total, 1);
    assert.equal(listed.problems[0].attempts, 1);
    assert.equal(listed.problems[0].difficulty, "Easy");
  });

  it("does not put old imported solutions in the review queue", async () => {
    const api = fakeApi({
      getRecentAccepted: async () => [
        submission("1", "old-one", "2025-01-01T10:00:00Z"),
        submission("2", "new-one", "2026-11-10T10:00:00Z"),
      ],
    });
    const tracker = build(api);
    await tracker.sync({});
    const reviews = await tracker.getDueReviews({});
    assert.deepEqual(reviews.due.map((item) => item.slug), ["new-one"]);
  });

  it("persists logged attempts and schedules reviews from confidence", async () => {
    await build().logAttempt({ problem: "two-sum", accepted: false, note: "off by one" });
    const history = await build().getProblemHistory({ problem: "two-sum" });
    assert.equal(history.history[0].note, "off by one");
    assert.equal(history.review.dueAt, "2026-11-19");
    assert.equal(history.solved, false);
  });

  it("rejects unknown problems without storing them", async () => {
    const tracker = build();
    await assert.rejects(tracker.logAttempt({ problem: "missing", accepted: true }), UserInputError);
    assert.equal((await tracker.listProblems({})).total, 0);
  });

  it("keeps offline attempts when LeetCode is unreachable", async () => {
    const { LeetCodeError } = await import("../dist/leetcode.js");
    const api = fakeApi({
      getQuestion: async () => {
        throw new LeetCodeError("offline");
      },
    });
    const result = await build(api).logAttempt({ problem: "two-sum", accepted: true });
    assert.equal(result.solved, true);
  });

  it("resumes a long history import from the saved cursor", async () => {
    const offsets = [];
    const api = fakeApi({
      hasSession: true,
      getSubmissionPage: async (offset) => {
        offsets.push(offset);
        return {
          submissions: [submission(String(offset), "two-sum", "2024-01-01T00:00:00Z", false)],
          hasNext: offset < 24,
          lastKey: `key-${offset}`,
        };
      },
    });
    const tracker = build(api);
    const first = await tracker.sync({ fullHistory: true });
    assert.equal(first.historyComplete, false);
    const second = await tracker.sync({ fullHistory: true });
    assert.equal(second.historyComplete, true);
    assert.equal(offsets.length, 25);
    assert.equal(new Set(offsets).size, 25);
  });

  it("requires a session for full history", async () => {
    await assert.rejects(build().sync({ fullHistory: true }), /LEETCODE_SESSION/);
  });

  it("sets, reports and removes goals", async () => {
    const tracker = build();
    await tracker.setGoal({ metric: "all", target: 20, deadline: "2026-11-22" });
    const progress = await tracker.getProgress({});
    assert.equal(progress.goals[0].remaining, 10);
    assert.equal(progress.percentSolved.all, 10);
    assert.deepEqual((await tracker.setGoal({ metric: "all", target: 0 })).goals, []);
    await assert.rejects(tracker.setGoal({ metric: "all", target: 5, deadline: "soon" }), UserInputError);
  });

  it("reports unknown users clearly", async () => {
    await assert.rejects(build().getProgress({ username: "ghost" }), /ghost/);
  });

  it("refuses to overwrite a damaged data file", async () => {
    const damaged = join(directory, "data.json");
    await writeFile(damaged, "{broken");
    const tracker = new Tracker(fakeApi(), new Store(damaged), { now: () => NOW });
    await assert.rejects(tracker.setGoal({ metric: "all", target: 5 }), /not valid JSON/);
    assert.equal(await readFile(damaged, "utf8"), "{broken");
  });
});

describe("LeetCode client", () => {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("retries once after rate limiting", async () => {
    let calls = 0;
    const client = new LeetCodeClient({
      retryDelayMs: 0,
      fetch: async () => {
        calls += 1;
        return calls === 1 ? json({}, 429) : json({ data: { question: null } });
      },
    });
    assert.equal(await client.getQuestion("nope"), null);
    assert.equal(calls, 2);
  });

  it("sends the session only to the submissions endpoint", async () => {
    const seen = [];
    const client = new LeetCodeClient({
      session: "secret",
      csrfToken: "csrf",
      fetch: async (url, init) => {
        seen.push({ url: String(url), cookie: init.headers.Cookie });
        return String(url).includes("graphql")
          ? json({ data: { question: null } })
          : json({ submissions_dump: [], has_next: false, last_key: "" });
      },
    });
    await client.getQuestion("two-sum");
    await client.getSubmissionPage(0, "");
    assert.equal(seen[0].cookie, undefined);
    assert.equal(seen[1].cookie, "LEETCODE_SESSION=secret; csrftoken=csrf");
  });

  it("explains an expired session without leaking it", async () => {
    const client = new LeetCodeClient({ session: "secret", fetch: async () => json({}, 403) });
    await assert.rejects(client.getSubmissionPage(0, ""), (error) => {
      assert.match(error.message, /Refresh LEETCODE_SESSION/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  });
});
