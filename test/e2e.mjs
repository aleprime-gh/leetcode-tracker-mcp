// Live smoke test: starts the built server over stdio and calls its tools against leetcode.com.
// Usage: node test/e2e.mjs <public-leetcode-username>
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const username = process.argv[2];
if (!username) throw new Error("Pass a public LeetCode username.");

const directory = await mkdtemp(join(tmpdir(), "lc-e2e-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: {
    ...process.env,
    LEETCODE_USERNAME: username,
    LEETCODE_TRACKER_DATA: join(directory, "data.json"),
  },
});
const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(transport);

let failures = 0;
async function call(name, args = {}, expectError = false) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  const passed = Boolean(result.isError) === expectError;
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${text.replace(/\s+/g, " ").slice(0, 260)}`);
  return text;
}

try {
  const { tools } = await client.listTools();
  console.log(`Tools (${tools.length}): ${tools.map((tool) => tool.name).join(", ")}`);
  await call("sync_progress");
  await call("get_progress");
  await call("log_attempt", {
    problem: "https://leetcode.com/problems/two-sum/",
    accepted: true,
    minutes: 12,
    confidence: 4,
    note: "hash map",
  });
  await call("get_problem_history", { problem: "two-sum" });
  await call("list_tracked_problems", { limit: 2 });
  await call("get_due_reviews", { upcoming_days: 30, limit: 2 });
  await call("analyze_topics", { limit: 2 });
  await call("set_goal", { metric: "medium", target: 500, deadline: "2027-06-01" });
  await call("get_daily_challenge");
  await call("log_attempt", { problem: "this-problem-does-not-exist-xyz", accepted: true }, true);
  await call("get_progress", { username: "no-such-user-xyz-000111" }, true);
  await call("sync_progress", { full_history: true }, true);
} finally {
  await client.close();
  await rm(directory, { recursive: true, force: true });
}
console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
