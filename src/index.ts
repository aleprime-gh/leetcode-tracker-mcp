#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Confidence } from "./domain.js";
import { LeetCodeClient } from "./leetcode.js";
import { defaultDataPath, Store } from "./store.js";
import { Tracker } from "./tracker.js";

const tracker = new Tracker(
  new LeetCodeClient({
    session: process.env.LEETCODE_SESSION,
    csrfToken: process.env.LEETCODE_CSRF_TOKEN,
  }),
  new Store(process.env.LEETCODE_TRACKER_DATA || defaultDataPath()),
  { defaultUsername: process.env.LEETCODE_USERNAME },
);

const server = new McpServer({ name: "leetcode-tracker", version: "0.1.0" });

async function respond(work: () => unknown) {
  try {
    const result = await work();
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}

const username = z
  .string()
  .min(1)
  .optional()
  .describe("LeetCode username. Defaults to LEETCODE_USERNAME.");
const problem = z.string().min(1).describe("Problem slug or URL, for example two-sum.");
const readOnly = { readOnlyHint: true, openWorldHint: true };

server.registerTool(
  "sync_progress",
  {
    description:
      "Import accepted submissions from LeetCode and record today's progress snapshot. Without a session LeetCode exposes only the latest 20 accepted submissions, so sync regularly.",
    inputSchema: {
      username,
      full_history: z
        .boolean()
        .optional()
        .describe("Import all submissions, including failed ones. Requires LEETCODE_SESSION."),
    },
  },
  ({ username, full_history }) =>
    respond(() => tracker.sync({ username, fullHistory: full_history })),
);

server.registerTool(
  "get_progress",
  {
    description:
      "Show solved counts by difficulty, ranking, streak, recent activity, weekly and monthly gains, goals and due reviews.",
    inputSchema: { username },
    annotations: readOnly,
  },
  ({ username }) => respond(() => tracker.getProgress({ username })),
);

server.registerTool(
  "log_attempt",
  {
    description:
      "Record a practice attempt with time, confidence and notes, then schedule the next spaced-repetition review.",
    inputSchema: {
      problem,
      accepted: z.boolean().describe("Whether the attempt ended with a working solution."),
      minutes: z.number().positive().max(1440).optional().describe("Time spent in minutes."),
      confidence: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("1 = could not solve it, 3 = solved with effort, 5 = solved easily."),
      note: z.string().max(4000).optional().describe("Approach, mistakes or insights."),
    },
  },
  ({ problem, accepted, minutes, confidence, note }) =>
    respond(() =>
      tracker.logAttempt({
        problem,
        accepted,
        minutes,
        confidence: confidence as Confidence | undefined,
        note,
      }),
    ),
);

server.registerTool(
  "get_problem_history",
  {
    description: "Show one problem's details, attempts, notes and review schedule.",
    inputSchema: { problem },
    annotations: readOnly,
  },
  ({ problem }) => respond(() => tracker.getProblemHistory({ problem })),
);

server.registerTool(
  "list_tracked_problems",
  {
    description: "List locally tracked problems, most recently attempted first.",
    inputSchema: {
      status: z.enum(["solved", "unsolved"]).optional(),
      difficulty: z.enum(["Easy", "Medium", "Hard"]).optional(),
      topic: z.string().optional().describe("Topic slug or name, for example dynamic-programming."),
      limit: z.number().int().min(1).max(500).optional().describe("Defaults to 50."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  (input) => respond(() => tracker.listProblems(input)),
);

server.registerTool(
  "get_due_reviews",
  {
    description: "List problems due for spaced-repetition review, most overdue first.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe("Defaults to 10."),
      upcoming_days: z
        .number()
        .int()
        .min(0)
        .max(90)
        .optional()
        .describe("Also show reviews due within this many days."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  ({ limit, upcoming_days }) =>
    respond(() => tracker.getDueReviews({ limit, upcomingDays: upcoming_days })),
);

server.registerTool(
  "analyze_topics",
  {
    description:
      "Find the least practiced topics at each level and the topics with the highest local failure rate.",
    inputSchema: {
      username,
      limit: z.number().int().min(1).max(30).optional().describe("Topics per group. Defaults to 5."),
    },
    annotations: readOnly,
  },
  ({ username, limit }) => respond(() => tracker.analyzeTopics({ username, limit })),
);

server.registerTool(
  "set_goal",
  {
    description:
      "Set a target for the total number of solved problems in a category. A target of 0 removes that goal.",
    inputSchema: {
      metric: z.enum(["all", "easy", "medium", "hard"]),
      target: z.number().int().min(0).describe("Total solved count to reach, not an increment."),
      deadline: z.string().optional().describe("Optional date in YYYY-MM-DD format."),
    },
  },
  (input) => respond(() => tracker.setGoal(input)),
);

server.registerTool(
  "get_daily_challenge",
  {
    description: "Show today's LeetCode daily challenge and whether it was solved before.",
    inputSchema: {},
    annotations: readOnly,
  },
  () => respond(() => tracker.getDailyChallenge()),
);

await server.connect(new StdioServerTransport());
