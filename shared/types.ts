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
/** v3: the projector shows the team on stage, or the event's own presentation (opening, break, sponsors, rules). */
export type StageScene = "team" | "event";

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
  /** v3: team on stage, or the event's own presentation. */
  scene: StageScene;
  /** v3: the event presentation on stage (scene "event"); its URL is public only while it is on stage. */
  eventPres: { fileId: number; url: string; pages: number | null; title: string } | null;
  /** v3: slide of the event presentation. */
  eventSlide: number;
  /** v3: timer bubble over the event presentation. */
  bubble: boolean;
  /** v3: projector effects set by the coordinator (last-5-seconds takeover, sounds). */
  fx: { last5: boolean; sound: boolean };
  /** v3: the team on stage may turn its own slides from its phone. */
  teamSlides: boolean;
}

/** v3: one of the event's own presentations (coordinator only; the stage gets a public URL while it is shown). */
export interface EventFile {
  id: number; title: string; name: string; ext: string; size: number; pages: number | null; conv: string | null; viewable: boolean; createdAt: number; url: string;
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
  event: { displayName: string; date: string; deadline: number | null; uploadsOpen: boolean; canRename: boolean; pitchSec: number; qaSec: number;
    /** v15: how many more times the team may change its name (null = no limit). */
    renamesLeft: number | null;
    /** v3: this team's own deadline (an extension the coordinator gave it), when later than the event's. */
    extendedUntil: number | null };
  /** v3: the team is on stage with its presentation and may turn its slides now. */
  slideControl: { allowed: boolean; reason: string | null; slide: number; pages: number | null };
  queue: TeamQueue;
  notices: Notice[];
  stage: StagePayload;
  soffice: boolean;
  maxUploadMb: number;
  /** v14: the team's own code, so a member can bring teammates in (they type it on /team). */
  code: string | null;
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
  /** v14: first sign-in of the team; null = it can still pick its name on the shared link. */
  claimedAt: number | null;
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
