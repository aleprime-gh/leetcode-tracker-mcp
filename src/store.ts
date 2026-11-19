import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Confidence, Goal, GoalMetric, Review, SolvedCounts } from "./domain.js";

export interface Attempt {
  at: string;
  source: "leetcode" | "manual";
  accepted: boolean;
  submissionId?: string;
  lang?: string;
  minutes?: number;
  confidence?: Confidence;
  note?: string;
}

export interface ProblemRecord {
  slug: string;
  title: string;
  frontendId?: string;
  difficulty?: string;
  topics: string[];
  metadataLoaded: boolean;
  attempts: Attempt[];
  review: Review | null;
}

export interface Snapshot {
  date: string;
  solved: SolvedCounts;
}

export interface TrackerState {
  version: 1;
  problems: Record<string, ProblemRecord>;
  snapshots: Snapshot[];
  goals: Partial<Record<GoalMetric, Goal>>;
  lastSyncAt: string | null;
  importCursor: { offset: number; lastKey: string } | null;
}

function emptyState(): TrackerState {
  return {
    version: 1,
    problems: {},
    snapshots: [],
    goals: {},
    lastSyncAt: null,
    importCursor: null,
  };
}

export function defaultDataPath(): string {
  return join(homedir(), ".leetcode-tracker", "data.json");
}

export class Store {
  private state: TrackerState | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  private async load(): Promise<TrackerState> {
    if (this.state) return this.state;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = emptyState();
      return this.state;
    }
    // A damaged file is reported rather than replaced, so tracking history is never lost.
    let parsed: TrackerState;
    try {
      parsed = JSON.parse(raw) as TrackerState;
    } catch {
      throw new Error(`Tracker data at ${this.path} is not valid JSON. Fix or move the file.`);
    }
    if (parsed.version !== 1) {
      throw new Error(`Tracker data at ${this.path} has unsupported version ${parsed.version}.`);
    }
    this.state = parsed;
    return parsed;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  read<T>(reader: (state: TrackerState) => T): Promise<T> {
    return this.enqueue(async () => reader(await this.load()));
  }

  /** Applies a change and persists it atomically. A throwing mutator leaves disk and memory unchanged. */
  update<T>(mutator: (state: TrackerState) => T): Promise<T> {
    return this.enqueue(async () => {
      const draft = structuredClone(await this.load());
      const result = mutator(draft);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(draft, null, 2), "utf8");
      await rename(temporary, this.path);
      this.state = draft;
      return result;
    });
  }
}
