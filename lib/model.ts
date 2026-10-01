import type { AppearancePreferences } from "./appearance";

export const divisions = [
  "Team Division",
  "Individual Juniors",
  "Individual Newcomer",
  "Individual Open",
  "Exhibition",
];
export const categories = [
  "Control",
  "Style",
  "Space Usage",
  "Choreography",
  "Construction",
  "Showmanship",
];
export const descriptions = [
  "Technical mastery and precision",
  "Individual flair and artistic expression",
  "Use of the performance area and movement",
  "Flow, transitions, and routine composition",
  "Routine structure and progression",
  "Stage presence and audience engagement",
];
export const tricks: Record<string, string[]> = {
  "#": ["2D", "3D", "4D"],
  T: ["1D", "2D", "3D", "4D", "VD"],
  O: ["1D", "2D", "3D", "4D", "VD"],
  F: ["2D", "3D", "4D"],
  S: ["1D", "2D", "3D", "4D", "VD"],
  W: ["1D", "VD"],
  R: ["1D", "2D", "3D", "4D", "VD"],
};
export const deductions = [
  "Unintentional Drop",
  "Tangle",
  "Time Violation",
  "Other Rule Violation",
];
export const executionOptions = ["E0", "E-1", "E-2", "E-3"] as const;
export type Execution = (typeof executionOptions)[number];
export const executionLabels: Record<Execution, string> = {
  E0: "E0 / Normal",
  "E-1": "E−1 / 10% reduction",
  "E-2": "E−2 / 20% reduction",
  "E-3": "E−3 / 30% reduction",
};
export type Profile = {
  id: string;
  name: string;
  role: "technical_judge" | "performance_judge" | "organizer" | "judge" | "server_admin";
  // Kept only to read pre-migration offline snapshots; never used as an account assignment.
  slot?: number | null;
  active: boolean;
  archived?: boolean;
  username?: string;
  // Time-limited URL generated from a private storage object by /api/state.
  avatar_url?: string | null;
  // Optional for pre-migration offline workspaces; missing means no added privilege.
  is_admin?: boolean;
  // Safe presentation-only settings for this profile; never copied to admin roster rows.
  appearance_preferences?: AppearancePreferences;
  appearance_updated_at?: string;
  hotkey_preferences?: { enabled: boolean; keys: Record<string, string> };
  hotkeys_updated_at?: string;
};
export type Competitor = {
  id: string;
  name: string;
  division: string;
  position: number;
  status: "upcoming" | "active" | "locked";
  dq: boolean;
  archived: boolean;
};
export type Event = {
  id: string;
  trick: string;
  level: number;
  features: string[];
  // Missing on legacy saved events; the scorer treats those as E0 / Normal.
  execution?: Execution;
  at: string;
  value?: number;
};
export type ScoringRules = {
  bases: Record<string, Record<string, number>>;
  deductions: Record<string, number>;
  levels: Record<string, number>;
  features: Record<string, number>;
  executions: Record<Execution, number>;
};
export type ScoringConfiguration = {
  revision: number;
  dataRevision: number;
  rules: ScoringRules;
  previousRevisions?: { revision: number; updatedAt: string | null; rules: ScoringRules }[];
};
export type Submission = {
  id: string;
  competitor_id: string;
  user_id: string | null;
  historical_user_id?: string | null;
  judge_name_snapshot?: string | null;
  judge_role_snapshot?: string | null;
  slot: number;
  // Scoring group is snapshotted at submission creation to preserve history.
  // Missing values on old offline snapshots fall back to the legacy internal order.
  scoring_type?: "technical" | "performance";
  events: Event[];
  performance: number[];
  finished: boolean;
  dq: boolean;
  version: number;
  updated_at: string;
  submitted_at?: string | null;
  total?: number;
};
export type Operation = {
  id: string;
  competitor_id: string;
  expected_version: number;
  kind: "put_event" | "delete_event" | "performance" | "finish" | "dq";
  payload: Record<string, unknown>;
  // Server-issued authorization context. The server accepts mutations only
  // while this is the currently open scoring window; local timestamps are not
  // trusted as proof that an offline action predates closure.
  scoring_config_revision?: number;
  scoring_window_revision?: string;
  scoring_window_token?: string;
};
export type Snapshot = {
  profile: Profile;
  competitors: Competitor[];
  submissions: Submission[];
  protected: boolean;
  divisions?: string[];
  profiles?: Profile[];
  audit?: Record<string, unknown>[];
  rankings?: Ranking[];
  personal?: { competitor_id: string; rank: number; total?: number }[];
  assignments?: {
    division: string;
    slot: number;
    user_id: string;
    scoring_type?: "technical" | "performance";
  }[];
  // True only when the server accepted this page's in-memory Admin unlock token.
  pointAccess?: boolean;
  // Sent only by /api/state when this request has valid Admin + Show Points access.
  scoringRules?: ScoringRules;
  // Safe non-numeric version metadata; used to flag stale offline queues.
  scoringConfigRevision?: number;
  scoringWindow?: {
    competitor_id: string;
    revision: string;
    token: string;
    opened_at: string;
  } | null;
  judgeRoster?: {
    competitor_id: string;
    user_id: string;
    scoring_type: "technical" | "performance";
    roster_order: number;
    display_name: string;
    role_snapshot: string;
    expected: boolean;
  }[];
};
export type Ranking = {
  competitor: Competitor;
  judges?: { user_id: string; scoring_type: "technical" | "performance"; roster_order: number; display_name: string }[];
  technical: (number | null)[];
  performance: (number | null)[];
  raw: number | null;
  scaled: number | null;
  average: number | null;
  final: number | null;
  complete: boolean;
  dq: boolean;
  rank: number | null;
};
export const demoCompetitors: Competitor[] = [
  "Ethan Chen",
  "Sophia Lin",
  "Austin Diabolo Collective",
  "Oliver Wang",
  "Mia Zhang",
  "Daniel Liu",
  "Houston Diabolo Club",
].map((name, i) => ({
  id: `demo-${i}`,
  name,
  division: divisions[[3, 3, 0, 1, 2, 3, 4][i]],
  position: i + 1,
  status: i === 0 ? "active" : "upcoming",
  dq: false,
  archived: false,
}));
