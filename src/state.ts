import type { TicketStatus } from "./types.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Resume state. Persisted after every ticket transition so a killed run can be
 * re-invoked with `--resume <run-id>` and pick up where it left off: already
 * merged tickets are skipped, in-flight ones restart, failed ones stay failed.
 */
export interface TicketState {
  status: TicketStatus;
  branch?: string;
  pr?: number;
  /** Fix-loop rounds completed. */
  rounds?: number;
  error?: string;
}

export interface RunState {
  runId: string;
  target: string;
  startedAt: string;
  updatedAt: string;
  /** issue number -> last known state. */
  tickets: Record<number, TicketState>;
}

export function statePath(runId: string): string {
  return `.scratch/dag-tickets/${runId}/state.json`;
}

export async function saveState(state: RunState, cwd?: string): Promise<void> {
  const path = statePath(state.runId);
  const full = cwd ? `${cwd.replace(/\/$/, "")}/${path}` : path;
  state.updatedAt = new Date().toISOString();
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export async function loadState(runId: string, cwd?: string): Promise<RunState | null> {
  const path = statePath(runId);
  const full = cwd ? `${cwd.replace(/\/$/, "")}/${path}` : path;
  const f = Bun.file(full);
  if (!(await f.exists())) return null;
  return (await f.json()) as RunState;
}
