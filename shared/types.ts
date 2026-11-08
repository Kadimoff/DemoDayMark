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
  /** munsif: "pending" = registered itself and waits for the coordinator (inactive until approved). */
  approval?: "pending" | "approved";
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
  /** Quick feedback chips the juror ticked (private, like the note). */
  tags: string[];
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

/** auto = the team's presentation when it has one, otherwise the big timer; timer = always the big timer; site = the team's website. */
export type StageMode = "auto" | "timer" | "site";
export const STAGE_MODES: readonly StageMode[] = ["auto", "timer", "site"];

/**
 * Presentation stage (munsif): what the projector shows besides the timer. Public, like the rest of the
 * stage payload, but only ever about the team on stage (its presentation URL serves only that team's file).
 */
export interface StageShow {
  mode: StageMode;
  /** 1-based slide shown on every stage screen. */
  slide: number;
  /** When the coordinator started the "Növbəti: …" intro (server time), or null. */
  introAt: number | null;
  /** The stage team's presentation as a PDF, or null. `url` is public only while the team is on stage. */
  pres: { fileId: number; url: string; pages: number | null } | null;
  /** A PPTX that is still converting (pending/running) or could not be converted (failed/unavailable). */
  presPending: string | null;
  site: { url: string; embeddable: boolean | null } | null;
  logo: string | null;
  members: string[];
  /** The team after the one on stage (for the intro and the idle screen). */
  next: { name: string; project: string } | null;
}

/** What every client (even anonymous projector screens) may see. */
export interface StagePayload {
  eventName: string;
  eventDate: string;
  team: StageTeam | null;
  timer: TimerState;
  serverNow: number;
  show: StageShow;
}

// ---------- teams (munsif): sign-in links, materials, notifications ----------
export type TeamReview = "none" | "submitted" | "accepted" | "returned";
export type TeamApproval = "pending" | "approved";

export interface TeamFile {
  id: number;
  kind: "presentation" | "logo";
  name: string;
  ext: string;
  size: number;
  pages: number | null;
  /** PPTX conversion: pending | running | done | failed | unavailable; null for PDFs and images. */
  conv: string | null;
  /** Can be shown with pdf.js (a PDF, or a PPTX that has been converted). */
  viewable: boolean;
  active: boolean;
  uploadedBy: "team" | "admin";
  createdAt: number;
  url: string;
}

export interface TeamMaterials {
  members: string[];
  siteUrl: string;
  videoUrl: string;
  siteEmbeddable: boolean | null;
  approval: TeamApproval;
  review: TeamReview;
  reviewNote: string;
  submittedAt: number | null;
  reviewedAt: number | null;
  extendUntil: number | null;
  presentation: TeamFile | null;
  logo: TeamFile | null;
}

export interface Notice {
  id: number;
  kind: string;
  title: string;
  body: string;
  teamId: number | null;
  at: number;
  read: boolean;
}

export interface TeamQueue { position: number; total: number; current: number; ahead: number | null; onStage: boolean }

/** Everything the team panel (/team) gets: only the team's own data, never scores. */
export interface TeamStatePayload {
  team: { id: number; name: string; project: string; active: boolean };
  materials: TeamMaterials;
  history: TeamFile[];
  event: { displayName: string; date: string; deadline: number | null; uploadsOpen: boolean; canRename: boolean; pitchSec: number; qaSec: number };
  queue: TeamQueue;
  notices: Notice[];
  stage: StagePayload;
  soffice: boolean;
  maxUploadMb: number;
}

/** One team in the admin's materials list. */
export interface AdminTeamMaterials extends TeamMaterials {
  teamId: number;
  name: string;
  project: string;
  active: boolean;
  orderIndex: number;
  link: { code: string | null; createdAt: number } | null;
  sessions: number;
}

export interface MyScore {
  teamId: number;
  values: ScoreValues;
  note: string;
  tags: string[];
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
  /** False for hackathons: there are no entry scores, the final score is the jurors' mean. */
  includeEntry: boolean;
  feedbackTags: string[];
  myScores: MyScore[];
  /** munsif: links to each active team's presentation / website, or null when the coordinator turned it off. */
  materials: Array<{ teamId: number; presentation: { url: string; name: string; pages: number | null } | null; siteUrl: string; videoUrl: string }> | null;
}

export interface PresenceEntry {
  jurorId: number;
  online: boolean;
  lastSeen: number | null;
}

/** Live draft progress of one juror (admin only): how many criteria are filled, never the values. */
export interface ProgressEntry {
  jurorId: number;
  teamId: number;
  filled: number;
  at: number;
}

export type TimerAction = "pitch" | "qa" | "toggle" | "pause" | "resume" | "reset" | "stop";

/** One entry of the permanent scoring history (admin only). */
export interface HistoryRow {
  id: number;
  kind: "submit" | "update" | "wipe" | "team.delete" | "juror.delete";
  at: number;
  jurorId: number | null; jurorName: string;
  teamId: number | null; teamName: string;
  /** Criteria as they were at that moment; `prev` is set on updates when the value changed. */
  values: Array<{ key: string; name: string; max: number | null; v: number; prev?: number }>;
  total: number | null; prevTotal: number | null;
  note: string; prevNote: string | null;
  tags: string[];
  actorName: string;
  /** Scores removed by a wipe or a deletion. */
  count: number | null;
}
export interface HistoryPage {
  rows: HistoryRow[];
  more: boolean;
  total: number;
  jurors: Array<{ id: number; name: string }>;
  teams: Array<{ id: number; name: string }>;
}
