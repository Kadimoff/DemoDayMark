// Types shared between the server and the browser bundles.

export type Role = "admin" | "juror";

export interface Criterion {
  id: number;
  key: string;
  name: string;
  description: string;
  /** Jurors give 1..maxScore points for this criterion. */
  maxScore: number;
  orderIndex: number;
}

export interface Team {
  id: number;
  name: string;
  project: string;
  orderIndex: number;
  active: boolean;
}

/** A team with its pre-Demo-Day entry score (visible to the admin and to jurors). */
export interface AdminTeam extends Team {
  entryScore: number | null;
}

export interface Juror {
  id: number;
  username: string;
  displayName: string;
  active: boolean;
}

export type ScoreValues = Record<string, number>;

export interface ScoreRow {
  jurorId: number;
  teamId: number;
  values: ScoreValues;
  note: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Shared pitch timer. The timer runs over one continuous timeline:
 * [0, pitchSec) is the pitch, [pitchSec, pitchSec + qaSec) is Q&A, after that "done".
 * position = offsetSec + (running ? (now - anchorAt) / 1000 : 0)
 */
export interface TimerState {
  visible: boolean;
  running: boolean;
  offsetSec: number;
  anchorAt: number | null;
  pitchSec: number;
  qaSec: number;
}

export interface StageTeam {
  id: number;
  name: string;
  project: string;
  index: number; // 1-based position among active teams
  total: number;
}

/** What every client (even anonymous projector screens) may see. */
export interface StagePayload {
  eventName: string;
  eventDate: string;
  team: StageTeam | null;
  timer: TimerState;
  serverNow: number;
}

export interface MyScore {
  teamId: number;
  values: ScoreValues;
  note: string;
  updatedAt: number;
  total?: number; // only present when show_juror_total is on
}

export interface JurorStatePayload {
  me: { id: number; displayName: string; username: string };
  locked: boolean;
  showJurorTotal: boolean;
  stage: StagePayload;
  /** Includes each team's entry score: jurors see it (decided by the organisers). */
  teams: AdminTeam[];
  entryMax: number;
  criteria: Criterion[];
  myScores: MyScore[];
}

export interface PresenceEntry {
  jurorId: number;
  online: boolean;
  lastSeen: number | null;
}

export type TimerAction = "pitch" | "qa" | "toggle" | "pause" | "resume" | "reset" | "stop";
