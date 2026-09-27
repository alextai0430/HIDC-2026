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
export type Profile = {
  id: string;
  name: string;
  role: "judge" | "server_admin";
  slot: number | null;
  active: boolean;
  username?: string;
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
  at: string;
  value?: number;
};
export type Submission = {
  id: string;
  competitor_id: string;
  user_id: string;
  slot: number;
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
};
export type Ranking = {
  competitor: Competitor;
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
