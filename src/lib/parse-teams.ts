/**
 * parse-teams.ts — Ingest and analysis of ~/.claude/teams/<id>/inboxes/<agent>.json
 *
 * Artifact shape: each file is a JSON array of TeamMessage objects. The `text`
 * field is a JSON-encoded payload; only messages whose payload type is
 * "task_assignment" are kept for analysis.
 *
 * This module is INGEST-ONLY (node:fs). It is never imported by SPA code and
 * MUST NOT be imported from any file under src/components/ or
 * src/lib/api-client*.ts. Use via scripts/ingest.mjs or server routes only.
 *
 * See REFERENCES.md for the authoritative artifact → parser map.
 *
 * Issue: #560 / prototype branch: proto/539-teams
 */

import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeMaxEntries,
  readDirentsBoundedSync,
  remainingEntryCapacity,
} from './bounded-fs';

// ─── Wire shapes ────────────────────────────────────────────────────────────

/** Raw shape of one entry in a teams inbox JSON array. */
export interface TeamMessage {
  from: string;
  /** JSON-encoded payload string. */
  text: string;
  timestamp: string;
  type: string;
  read: boolean;
}

/** Decoded task_assignment payload embedded in TeamMessage.text. */
export interface TaskAssignmentPayload {
  type: 'task_assignment';
  taskId: string;
  subject: string;
  description?: string;
  assignedBy?: string;
  /** Timestamp may also live in the payload (mirrors envelope timestamp). */
  timestamp?: string;
}

/** A task_assignment message with its decoded payload attached. */
export interface TeamAssignment {
  agent: string;
  from: string;
  timestamp: string;
  read: boolean;
  payload: TaskAssignmentPayload;
}

// ─── Analysis shapes ─────────────────────────────────────────────────────────

/** Detail row for a single dropped (unread, past grace window) assignment. */
export interface DroppedAssignment {
  agent: string;
  taskId: string;
  subject: string;
  /** Age in whole minutes at the time of analysis. */
  ageMinutes: number;
}

/** An agent whose every task assignment is unread (work never started). */
export interface StalledAgent {
  agent: string;
  /** Number of unread assignments. */
  unreadCount: number;
}

/** Per-team analysis result surfaced to the recommendations engine. */
export interface TeamSummary {
  teamId: string;
  totalAssignments: number;
  droppedCount: number;
  /** 0–100, rounded. */
  droppedPct: number;
  droppedAssignments: DroppedAssignment[];
  stalledAgents: StalledAgent[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Minutes after dispatch before an unread assignment is counted as dropped. */
export const GRACE_MINUTES = 10;

export interface ParseTeamsOptions {
  maxFileBytes?: number;
  maxEntries?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeParse(text: string): TaskAssignmentPayload | null {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && v.type === 'task_assignment') {
      return v as TaskAssignmentPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function listSubdirs(dir: string, maxEntries: number): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readDirentsBoundedSync(dir, maxEntries).map((entry) => entry.name).filter((entry) => {
      try {
        return statSync(join(dir, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function loadAgentAssignments(
  inboxDir: string,
  agent: string,
  maxFileBytes: number
): TeamAssignment[] {
  const filePath = join(inboxDir, `${agent}.json`);
  let msgs: TeamMessage[];
  try {
    const fileStat = statSync(filePath);
    if (
      !fileStat.isFile() ||
      (maxFileBytes >= 0 && fileStat.size > maxFileBytes)
    ) {
      return [];
    }
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    msgs = parsed as TeamMessage[];
  } catch {
    return [];
  }

  return msgs
    .filter((m): m is TeamMessage => m != null && typeof m === 'object')
    .flatMap((m) => {
      const payload = safeParse(m.text);
      if (!payload) return [];
      return [
        {
          agent,
          from: m.from ?? '',
          timestamp: m.timestamp ?? '',
          read: m.read === true,
          payload,
        } satisfies TeamAssignment,
      ];
    });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Walk `<dir>/<teamId>/inboxes/<agent>.json` for every team found, parse each
 * message, and return the raw assignments per team keyed by teamId.
 *
 * @param dir  Absolute path to the `teams/` directory (e.g. `~/.claude/teams`).
 */
export function parseTeamsDir(
  dir: string,
  opts: ParseTeamsOptions = {}
): Map<string, TeamAssignment[]> {
  const result = new Map<string, TeamAssignment[]>();
  const maxFileBytes =
    typeof opts.maxFileBytes === 'number' &&
    Number.isFinite(opts.maxFileBytes) &&
    opts.maxFileBytes >= 0
      ? Math.floor(opts.maxFileBytes)
      : -1;
  const maxEntries = normalizeMaxEntries(opts.maxEntries);
  const teamIds = listSubdirs(dir, maxEntries);
  let inboxEntriesRead = 0;

  for (const teamId of teamIds) {
    if (inboxEntriesRead >= maxEntries) break;
    const inboxDir = join(dir, teamId, 'inboxes');
    if (!existsSync(inboxDir)) continue;

    const agentFiles = readDirentsBoundedSync(
      inboxDir,
      remainingEntryCapacity(maxEntries, inboxEntriesRead)
    )
      .map((entry) => entry.name)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));

    const allAssignments: TeamAssignment[] = [];
    for (const agent of agentFiles) {
      if (inboxEntriesRead >= maxEntries) break;
      inboxEntriesRead += 1;
      allAssignments.push(...loadAgentAssignments(inboxDir, agent, maxFileBytes));
    }

    result.set(teamId, allAssignments);
  }

  return result;
}

/**
 * Analyse parsed team assignments, returning per-team summaries of dropped
 * assignments and stalled agents.
 *
 * @param teamAssignments  Output of {@link parseTeamsDir}.
 * @param now              Reference timestamp in ms (Date.now() or anchored to
 *                         the latest message for deterministic tests).
 * @param graceMinutes     Unread assignments younger than this are not counted
 *                         as dropped (grace window for in-flight work).
 *                         Defaults to {@link GRACE_MINUTES}.
 */
export function analyzeTeams(
  teamAssignments: Map<string, TeamAssignment[]>,
  now: number,
  graceMinutes: number = GRACE_MINUTES
): TeamSummary[] {
  const summaries: TeamSummary[] = [];

  for (const [teamId, assignments] of teamAssignments) {
    if (assignments.length === 0) continue;

    // Group by agent so we can detect stalled agents.
    const byAgent = new Map<string, TeamAssignment[]>();
    for (const a of assignments) {
      const bucket = byAgent.get(a.agent) ?? [];
      bucket.push(a);
      byAgent.set(a.agent, bucket);
    }

    const droppedAssignments: DroppedAssignment[] = [];
    const stalledAgents: StalledAgent[] = [];

    for (const [agent, agentAssigns] of byAgent) {
      if (agentAssigns.length === 0) continue;

      const dropped = agentAssigns.filter((a) => {
        if (a.read) return false;
        const ts = Date.parse(a.timestamp) || 0;
        const ageMin = (now - ts) / 60_000;
        return ageMin >= graceMinutes;
      });

      if (dropped.length === agentAssigns.length) {
        // Every assignment is unread past grace = stalled agent
        stalledAgents.push({ agent, unreadCount: dropped.length });
      }

      for (const d of dropped) {
        const ts = Date.parse(d.timestamp) || 0;
        droppedAssignments.push({
          agent,
          taskId: d.payload.taskId,
          subject: d.payload.subject,
          ageMinutes: Math.round((now - ts) / 60_000),
        });
      }
    }

    const totalAssignments = assignments.length;
    const droppedCount = droppedAssignments.length;
    const droppedPct = Math.round((droppedCount / totalAssignments) * 100);

    summaries.push({
      teamId,
      totalAssignments,
      droppedCount,
      droppedPct,
      droppedAssignments,
      stalledAgents,
    });
  }

  return summaries;
}
