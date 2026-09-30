"use client";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Cloud,
  CloudOff,
  Download,
  Flag,
  Keyboard,
  Layers,
  Lock,
  LogOut,
  Plus,
  Radio,
  Save,
  Shield,
  SlidersHorizontal,
  Trophy,
  Users,
  X,
  Pencil,
  PanelLeft,
  UserRound,
  Camera,
  Trash2,
} from "lucide-react";
import {
  canManage,
  isAssignedJudge,
  canManageScoringConfiguration,
  profileCanScoreType,
  scoringTabs,
} from "@/lib/access";
import { api, ApiResponseError, demo, supabase } from "@/lib/supabase";
import { PasswordField } from "@/app/components/password-field";
import { profilePasswordError } from "@/lib/password-validation";
import { applyLocal, clearLocal, LocalWorkspace, mergeRemoteSnapshotPreservingQueue, readLocal, rebaseQueuedOperationsToOpenWindow, sanitizeWorkspace, writeLocal } from "@/lib/local";
import {
  categories,
  Competitor,
  deductions,
  demoCompetitors,
  divisions,
  executionLabels,
  executionOptions,
  Event,
  Operation,
  Profile,
  Snapshot,
  Submission,
  tricks,
} from "@/lib/model";
import { matchHotkeyAction, stepTechnicalLevel, technicalLevels } from "@/lib/technical-controls";
import { download } from "@/lib/export";
import TechnicalPointConfiguration from "@/app/components/technical-point-configuration";
import AppearanceSettings, { type AppearanceSaveResult } from "@/app/components/appearance-settings";
import { applyAppearance, AppearancePreferences, defaultAppearance, normalizeAppearancePreferences } from "@/lib/appearance";
import {
  detailExportRows,
  detailSubmissions,
  ownSubmissions,
  personalScoreExportRows,
} from "@/lib/scoped";

const defaultKeys: Record<string, string> = {
  submit: "Enter",
  clear: "Escape",
  undo: "Backspace",
  finish: "Shift+Enter",
  "level:next": "]",
  "level:previous": "[",
  "execution:E0": "e0",
  "execution:E-1": "e1",
  "execution:E-2": "e2",
  "execution:E-3": "e3",
  "tab:Saved Competitors": "Alt+s",
  "tab:Rankings": "Alt+r",
  ...Object.fromEntries(
    Object.entries(tricks).flatMap(([type, dims]) =>
      dims.map((dim) => [
        `${type} ${dim}`,
        `${type === "#" ? "h" : type.toLowerCase()}${dim === "VD" ? "v" : dim[0]}`,
      ]),
    ),
  ),
  ...Object.fromEntries(
    technicalLevels.map((n) => [
      `level:${n}`,
      n === 10 ? "0" : n === 0.5 ? "`" : `${n}`,
    ]),
  ),
  T1: "Shift+1",
  T2: "Shift+2",
  T3: "Shift+3",
  A: "a",
  "Unintentional Drop": "d",
  Tangle: "g",
  "Time Violation": "v",
  "Other Rule Violation": "b",
};
const fmt = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(2));
const uid = () => crypto.randomUUID();
const executionControlLabels: Record<(typeof executionOptions)[number], string> = {
  E0: "E0",
  "E-1": "E−1",
  "E-2": "E−2",
  "E-3": "E−3",
};

type AccountFormState =
  | {
      mode: "create";
      name: string;
      username: string;
      role: Profile["role"];
      password: string;
    }
  | {
      mode: "edit";
      id: string;
      name: string;
      username: string;
      role: Profile["role"];
      password: string;
    };

function createAccountForm(): AccountFormState {
  return { mode: "create", name: "", username: "", role: "technical_judge", password: "" };
}

function editAccountForm(profile: Profile): AccountFormState {
  return {
    mode: "edit",
    id: profile.id,
    name: profile.name,
    username: profile.username ?? "",
    role: profile.role === "performance_judge" || (profile.role === "judge" && (profile.slot ?? 1) > 3)
      ? "performance_judge"
      : profile.role === "organizer" || profile.role === "server_admin"
        ? "organizer"
        : "technical_judge",
    password: "",
  };
}

function SubmissionEventDetail({
  event,
  index,
  revealPoints,
}: {
  event: Event;
  index: number;
  revealPoints: boolean;
}) {
  const deduction = deductions.includes(event.trick);
  const category = deduction ? "deduction" : event.trick.split(" ")[0];
  return (
    <div
      className={`detail-event ${deduction ? "deduction" : ""}`}
      data-category={category}
    >
      <div className="detail-event-main">
        <b className="detail-event-title">
          <span className="detail-event-index">{index + 1}.</span> {event.trick}
        </b>
        <span className="detail-event-meta">
          {deduction
            ? "Deduction"
            : `L${event.level} · ${event.features.join(" + ") || "No features"} · ${executionLabels[event.execution ?? "E0"]}`}
        </span>
      </div>
      <b className="detail-event-points">
        {revealPoints && event.value !== undefined
          ? `${fmt(event.value)} points`
          : "*** points"}
      </b>
      <time className="detail-event-time">{new Date(event.at).toLocaleString()}</time>
    </div>
  );
}

const hotkeyActionLabel = (action: string) => {
  if (action === "level:next") return "Level + (next)";
  if (action === "level:previous") return "Level − (previous)";
  if (action.startsWith("execution:")) {
    const executionKey = action.slice("execution:".length) as (typeof executionOptions)[number];
    return `Execution ${executionControlLabels[executionKey] ?? executionKey}`;
  }
  if (action === "finish") return "Submit score";
  if (action.startsWith("level:")) return `Level ${action.slice("level:".length)}`;
  if (action.startsWith("tab:")) return `Go to ${action.slice("tab:".length)}`;
  return action;
};
type ScoringType = "technical" | "performance";
type JudgeAssignment = { division: string; slot: number; user_id: string; scoring_type?: ScoringType };
const profileScoringType = (profile?: Profile | null): ScoringType => profile?.role === "performance_judge" ? "performance" : "technical";
const assignmentScoringType = (assignment?: JudgeAssignment, profile?: Profile): ScoringType =>
  assignment?.scoring_type ?? profileScoringType(profile);
const roleLabel = (role: Profile["role"]) => role === "technical_judge" ? "Technical Judge" : role === "performance_judge" ? "Performance Judge" : "Organizer";
const profileRoleLabel = (profile: Profile, scoringType?: ScoringType) => profile.role === "judge"
  ? `${scoringType === "performance" ? "Performance" : "Technical"} Judge`
  : roleLabel(profile.role);
function defaultScoreTab(snapshot: Snapshot) {
  if (canManage(snapshot.profile)) return "Server Access Control";
  const active = snapshot.competitors.find((competitor) => competitor.status === "active" && !competitor.archived);
  const assignment = active && snapshot.assignments?.find((row) => row.division === active.division && row.user_id === snapshot.profile.id);
  return assignmentScoringType(assignment, snapshot.profile) === "performance" ? "Performance" : "Technical";
}
const blankDemo = (role: Profile["role"] = "technical_judge"): Snapshot => {
  const sampleJudges = [1, 2, 3, 4, 5].map((order): Profile => ({
    id: `demo-user-${order}`,
    name: ["Taylor Chen", "Morgan Lee", "Riley Shah", "Jordan Kim", "Casey Wu"][order - 1],
    username: ["taylorchen", "morganlee", "rileyshah", "jordankim", "caseywu"][order - 1],
    role: order <= 3 ? "technical_judge" : "performance_judge",
    active: true,
  }));
  const demoRoster: Competitor[] = demoCompetitors.map((competitor, index) => ({
    ...competitor,
    status: index === 0 ? "locked" : index === 1 ? "active" : "upcoming",
  }));
  const timestamp = new Date().toISOString();
  const finishedSample = demoRoster[0];
  const activeSample = demoRoster[1];
  const sampleSubmissions = [
    ...sampleJudges.map((judge) => ({
      id: `demo-sub-${finishedSample.id}-${judge.id}`,
      competitor_id: finishedSample.id,
      user_id: judge.id,
      slot: sampleJudges.indexOf(judge) + 1,
      scoring_type: profileScoringType(judge),
      events: [],
      performance: [3, 3, 3, 3, 3, 3],
      finished: true,
      dq: false,
      version: 1,
      updated_at: timestamp,
      submitted_at: timestamp,
    })),
    {
      id: `demo-sub-${activeSample.id}-1`,
      competitor_id: activeSample.id,
      user_id: sampleJudges[0].id,
      slot: 1,
      scoring_type: "technical" as const,
      events: [{ id: "demo-event-progress", trick: "T 2D", level: 2, features: [], at: timestamp }],
      performance: [0, 0, 0, 0, 0, 0],
      finished: false,
      dq: false,
      version: 1,
      updated_at: timestamp,
    },
  ];
  return {
    profile: {
      id: `demo-user-${role === "organizer" || role === "server_admin" ? "organizer" : role === "performance_judge" ? 4 : 1}`,
      name: role === "organizer" || role === "server_admin" ? "Event organizer" : sampleJudges[role === "performance_judge" ? 3 : 0].name,
      role,
      active: true,
    },
    competitors: demoRoster,
    submissions: sampleSubmissions,
    protected: role === "organizer" || role === "server_admin",
    profiles: sampleJudges,
    assignments: allDemoDivisions.map((division) =>
      sampleJudges.map((judge, index) => ({ division, slot: index + 1, user_id: judge.id, scoring_type: profileScoringType(judge) })),
    ).flat(),
    audit: [],
    rankings: [],
    personal: [],
  };
};
const allDemoDivisions = [...new Set(demoCompetitors.map((competitor) => competitor.division))];

export default function Page() {
  const [workspace, setWorkspace] = useState<LocalWorkspace | null>(null);
  const ref = useRef<LocalWorkspace | null>(null);
  const busy = useRef(false);
  const lastSubmit = useRef(0);
  const chain = useRef(Promise.resolve());
  const [ready, setReady] = useState(false),
    [online, setOnline] = useState(true),
    [syncing, setSyncing] = useState(false),
    [refreshQueued, setRefreshQueued] = useState(false),
    [refreshingCompetitor, setRefreshingCompetitor] = useState(false),
    [syncError, setSyncError] = useState(""),
    [scoringReconciliationNotice, setScoringReconciliationNotice] = useState(""),
    [notice, setNotice] = useState(""),
    [tab, setTab] = useState("Technical"),
    [technicalViewJudgeId, setTechnicalViewJudgeId] = useState(""),
    [performanceViewJudgeId, setPerformanceViewJudgeId] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [theme, setTheme] = useState("light");
  const [appearance, setAppearance] = useState<AppearancePreferences>(defaultAppearance);
  const [themePreference, setThemePreference] = useState<"system" | "light" | "dark">("light");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"account" | "appearance" | "hotkeys" | "privacy" | "session" | null>("account");
  const [profileName, setProfileName] = useState("");
  const [profileUsername, setProfileUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newLoginPassword, setNewLoginPassword] = useState("");
  const [confirmLoginPassword, setConfirmLoginPassword] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [profileMessageError, setProfileMessageError] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [appearanceSyncError, setAppearanceSyncError] = useState("");
  const appearanceSyncBusy = useRef(false);
  const [newDivision, setNewDivision] = useState("");
  const [divisionFormOpen, setDivisionFormOpen] = useState(false);
  const [divisionDeleteTarget, setDivisionDeleteTarget] = useState("");
  const [divisionDeleteConfirmation, setDivisionDeleteConfirmation] = useState("");
  const [submittingCompetitors, setSubmittingCompetitors] = useState<Set<string>>(() => new Set());
  const [trick, setTrick] = useState(""),
    [level, setLevel] = useState(1),
    [execution, setExecution] = useState<(typeof executionOptions)[number]>("E0"),
    [features, setFeatures] = useState<string[]>([]),
    [editing, setEditing] = useState<Event | null>(null),
    [hotkeys, setHotkeys] = useState(defaultKeys),
    [keysEnabled, setKeysEnabled] = useState(true),
    [modal, setModal] = useState<{
      title: string;
      body: string;
      action: () => void;
      confirmLabel?: string;
      danger?: boolean;
    } | null>(null);
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [loginBusy, setLoginBusy] = useState(false),
    [adminPassword, setAdminPassword] = useState(""),
    [adminPasswordError, setAdminPasswordError] = useState(""),
    [adminPasswordBusy, setAdminPasswordBusy] = useState(false),
    [adminUnlocked, setAdminUnlocked] = useState(false),
    [adminUnlockToken, setAdminUnlockToken] = useState<string | null>(null),
    [showPoints, setShowPoints] = useState(false),
    [newAdminTabPassword, setNewAdminTabPassword] = useState(""),
    [confirmAdminTabPassword, setConfirmAdminTabPassword] = useState(""),
    [adminTabPasswordMessage, setAdminTabPasswordMessage] = useState(""),
    [filter, setFilter] = useState("All divisions"),
    [assignmentDivision, setAssignmentDivision] = useState(divisions[0]),
    [assignmentDraft, setAssignmentDraft] = useState<Record<string, { user_id: string; scoring_type: ScoringType }> | null>(null),
    [competitorEdit, setCompetitorEdit] = useState<Partial<Competitor> | null>(
      null,
    ),
    [userEdit, setUserEdit] = useState<AccountFormState | null>(null),
    [accountDeleteTarget, setAccountDeleteTarget] = useState<Profile | null>(null),
    [accountDeleteConfirmation, setAccountDeleteConfirmation] = useState(""),
    [accountFormError, setAccountFormError] = useState("");
  const state = workspace?.snapshot;
  const profile = state?.profile;
  const server = !!profile && canManage(profile);
  const canManageScoringConfig = !!profile && canManageScoringConfiguration(profile);
  const organizer = profile?.role === "organizer" || profile?.role === "server_admin";
  const canViewPoints =
    adminUnlocked && showPoints && !!adminUnlockToken && state?.pointAccess === true;
  const canViewSubmissionPoints = (submission?: Submission) =>
    !!submission && canViewPoints;
  const canViewPersonalPoints = (competitorId: string) =>
    canViewPoints && !!state?.submissions.some((submission) => submission.competitor_id === competitorId);
  const active = state?.competitors.find(
    (c) => c.status === "active" && !c.archived,
  );
  const canReconcilePendingWindow = !!profile && isAssignedJudge(profile) &&
    !!workspace?.queue.length && !!active &&
    state?.scoringWindow?.competitor_id === active.id &&
    workspace.queue.every((operation) => operation.competitor_id === active.id) &&
    workspace.queue.some((operation) => operation.scoring_window_revision !== state.scoringWindow?.revision ||
      operation.scoring_window_token !== state.scoringWindow?.token);
  const current = state?.competitors.find(
    (c) => c.id === (selected ?? active?.id),
  );
  const currentRosterAssignment = state?.judgeRoster?.find((row) =>
    row.competitor_id === current?.id && row.user_id === profile?.id && row.expected,
  );
  const currentAssignment = state?.assignments?.find(
    (assignment) => assignment.division === current?.division && assignment.user_id === profile?.id,
  ) ?? (currentRosterAssignment ? {
    division: current?.division ?? "", slot: currentRosterAssignment.roster_order,
    user_id: currentRosterAssignment.user_id, scoring_type: currentRosterAssignment.scoring_type,
  } : undefined);
  const technical = server
    ? tab !== "Performance"
    : assignmentScoringType(currentAssignment, profile) === "technical";
  const currentJudgeRoster = state?.judgeRoster?.filter((row) => row.competitor_id === current?.id && row.expected);
  const currentRoleAssignments = (currentJudgeRoster
    ? currentJudgeRoster.map((row) => ({ division: current?.division ?? "", slot: row.roster_order, user_id: row.user_id, scoring_type: row.scoring_type, display_name: row.display_name }))
    : (state?.assignments ?? []).filter((assignment) => assignment.division === current?.division).map((assignment) => ({ ...assignment, display_name: undefined as string | undefined })))
    .filter((assignment) => assignmentScoringType(assignment, state?.profiles?.find((judge) => judge.id === assignment.user_id)) === (tab === "Performance" ? "performance" : "technical"))
    .sort((a, b) => a.slot - b.slot);
  const selectedJudgeId = server
    ? (tab === "Performance" ? performanceViewJudgeId : technicalViewJudgeId)
    : profile?.id ?? "";
  const viewingJudgeId = currentRoleAssignments.some((assignment) => assignment.user_id === selectedJudgeId)
    ? selectedJudgeId
    : currentRoleAssignments[0]?.user_id ?? selectedJudgeId;
  const own = state?.submissions.find(
    (s) => s.competitor_id === current?.id && s.user_id === profile?.id,
  );
  const displayed = state?.submissions.find(
    (s) =>
      s.competitor_id === current?.id &&
      (s.user_id === viewingJudgeId || s.historical_user_id === viewingJudgeId),
  );
  const visibleSubmissions =
    profile && state ? detailSubmissions(profile, state.submissions) : [];
  const personalSubmissions =
    profile && state ? ownSubmissions(profile, state.submissions) : [];
  const submissionPending = !!current && submittingCompetitors.has(current.id) && displayed?.user_id === profile?.id;
  const submissionSubmitted = !!displayed?.finished || submissionPending;
  const canScore =
    !!profile &&
    isAssignedJudge(profile) &&
    !!currentAssignment &&
    assignmentScoringType(currentAssignment, profile) === (tab === "Performance" ? "performance" : "technical") &&
    !!current &&
    (demo || (state?.scoringWindow?.competitor_id === current.id &&
      !!state.scoringWindow.revision && !!state.scoringWindow.token)) &&
    !current.archived &&
    current.status === "active" &&
    !submissionSubmitted;
  const allDivisions = Array.from(new Set([
    ...(state ? state.divisions ?? [] : divisions),
    ...(state?.competitors.map((c) => c.division) ?? []),
  ]));
  const allDivisionKey = allDivisions.join("\u0000");
  useEffect(() => {
    const options = allDivisionKey ? allDivisionKey.split("\u0000") : [];
    if (!options.length) {
      if (assignmentDivision) setAssignmentDivision("");
      setAssignmentDraft(null);
    } else if (!options.includes(assignmentDivision)) {
      setAssignmentDivision(options[0]);
      setAssignmentDraft(null);
    }
  }, [allDivisionKey, assignmentDivision]);
  const syncStatus = demo
    ? "Score saved locally · demo"
    : syncError && workspace?.queue.length
      ? "Sync failed · score saved locally"
      : syncing
        ? "Syncing score…"
        : workspace?.queue.length
          ? "Score saved locally"
          : "Score synced";
  const divisionAssignments = (state?.assignments ?? []).filter(
    (a) => a.division === assignmentDivision,
  );
  const assignmentLocked = (state?.competitors ?? []).some((competitor) => competitor.division === assignmentDivision);
  const divisionProfiles = (state?.profiles ?? []).filter(
    (p) => p.active && !p.archived,
  );
  const currentAssignmentDraft: Record<string, { user_id: string; scoring_type: ScoringType }> = Object.fromEntries(
    divisionAssignments.map((a) => [String(a.slot), {
      user_id: a.user_id,
      scoring_type: assignmentScoringType(a, state?.profiles?.find((judge) => judge.id === a.user_id)),
    }]),
  );
  const editableAssignments = assignmentDraft ?? currentAssignmentDraft;
  const editableAssignmentRows = Object.entries(editableAssignments)
    .map(([slot, row]) => ({ slot: Number(slot), ...row }))
    .sort((a, b) => a.slot - b.slot);
  const competitorDraftRoster = (state?.assignments ?? []).filter(
    (assignment) => assignment.division === competitorEdit?.division,
  );
  const competitorDraftRosterValid = competitorDraftRoster.length >= 2 &&
    competitorDraftRoster.length <= 10 &&
    competitorDraftRoster.some((assignment) => assignment.scoring_type === "technical") &&
    competitorDraftRoster.some((assignment) => assignment.scoring_type === "performance");
  const nextUpcoming = [...(state?.competitors ?? [])]
    .filter((c) => c.status === "upcoming" && !c.archived)
    .sort((a, b) => a.position - b.position)[0];
  const oldestQueuedConfigRevision = workspace?.queue.length
    ? Math.min(...workspace.queue.map((op) => op.scoring_config_revision ?? state?.scoringConfigRevision ?? 1))
    : undefined;
  const progressRows = [...(state?.competitors ?? [])]
    .filter((c) => !c.archived)
    .sort((a, b) => a.position - b.position)
    .map((competitor) => {
      const official = state?.judgeRoster?.filter((judge) => judge.competitor_id === competitor.id && judge.expected);
      const judges = official
        ? official.map((judge) => ({ division: competitor.division, slot: judge.roster_order, user_id: judge.user_id, scoring_type: judge.scoring_type, display_name: judge.display_name }))
        : (state?.assignments ?? []).filter((assignment) => assignment.division === competitor.division);
      judges.sort((a, b) => a.slot - b.slot);
      const entries = judges.map((judge) => {
        const judgeProfile = state?.profiles?.find((p) => p.id === judge.user_id);
        const scoringType = assignmentScoringType(judge, judgeProfile);
        const submission = state?.submissions.find(
          (s) => s.competitor_id === competitor.id && (s.user_id === judge.user_id || s.historical_user_id === judge.user_id) &&
            s.scoring_type === scoringType,
        );
        return {
          ...judge,
          name: judgeProfile?.name ?? ("display_name" in judge && typeof judge.display_name === "string" ? judge.display_name : "Former judge"),
          scoring_type: scoringType,
          status: submission?.finished
            ? "Submitted"
            : submission && submission.version > 0
              ? "In progress"
              : "Not started",
        };
      });
      const complete = entries.length >= 2 && entries.some((entry) => entry.scoring_type === "technical") && entries.some((entry) => entry.scoring_type === "performance") && entries.every((entry) => entry.status === "Submitted");
      const started = entries.some((entry) => entry.status !== "Not started");
      return {
        competitor,
        entries,
        complete,
        started,
        stateLabel: complete ? "Complete" : competitor.status === "active" ? "Active · in progress" : started ? "Started · incomplete" : "Not started · locked",
      };
    });
  const validProgressAssignments = (entries: { scoring_type: ScoringType }[]) =>
    entries.length >= 2 && entries.length <= 10 &&
    entries.some((entry) => entry.scoring_type === "technical") &&
    entries.some((entry) => entry.scoring_type === "performance");
  const accountHasScoreHistory = (accountId: string) =>
    (state?.submissions ?? []).some((submission) => submission.user_id === accountId && (
      submission.version > 0 || submission.finished || submission.dq || submission.events.length > 0 || submission.performance.some((value) => value !== 0)
    )) || (state?.audit ?? []).some((row) => row.user_id === accountId && ["put_event", "delete_event", "performance", "finish", "dq"].includes(String(row.action)));
  const previewAppearance = useCallback((preferences: AppearancePreferences) => {
    const effective = preferences.mode === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : preferences.mode;
    setAppearance(preferences);
    setThemePreference(preferences.mode);
    setTheme(effective);
    applyAppearance(preferences, effective);
  }, []);
  const changeThemePreference = (preference: "system" | "light" | "dark") => {
    const nextAppearance = { ...appearance, mode: preference };
    previewAppearance(nextAppearance);
    void saveAppearancePreferences(nextAppearance).catch((error) => {
      setAppearanceSyncError((error as Error).message);
    });
  };
  const commit = useCallback(async (next: LocalWorkspace) => {
    if (demo) {
      next = {
        ...next,
        snapshot: {
          ...next.snapshot,
          protected: canManage(next.snapshot.profile),
        },
      };
    }
    const previousWorkspace = ref.current;
    const previousPending = previousWorkspace?.snapshot.profile.id === next.snapshot.profile.id
      ? previousWorkspace.appearancePending
      : undefined;
    if (next.appearancePending === undefined && previousPending) {
      const serverUpdatedAt = Date.parse(next.snapshot.profile.appearance_updated_at ?? "1970-01-01T00:00:00.000Z");
      if (Date.parse(previousPending.updatedAt) > serverUpdatedAt) {
        next = {
          ...next,
          appearancePending: previousPending,
          snapshot: {
            ...next.snapshot,
            profile: {
              ...next.snapshot.profile,
              appearance_preferences: previousPending.preferences,
              appearance_updated_at: previousPending.updatedAt,
            },
          },
        };
      }
    }
    const previousHotkeyPending = previousWorkspace?.snapshot.profile.id === next.snapshot.profile.id
      ? previousWorkspace.hotkeysPending
      : undefined;
    if (next.hotkeysPending === undefined && previousHotkeyPending) {
      const serverUpdatedAt = Date.parse(next.snapshot.profile.hotkeys_updated_at ?? "1970-01-01T00:00:00.000Z");
      if (Date.parse(previousHotkeyPending.updatedAt) > serverUpdatedAt) {
        next = {
          ...next,
          hotkeysPending: previousHotkeyPending,
          snapshot: {
            ...next.snapshot,
            profile: {
              ...next.snapshot.profile,
              hotkey_preferences: previousHotkeyPending.preferences,
              hotkeys_updated_at: previousHotkeyPending.updatedAt,
            },
          },
        };
      }
    }
    const viewer = next.snapshot.profile;
    if (!canManage(viewer)) {
      const ownSubmissions = next.snapshot.submissions.filter((submission) => submission.user_id === viewer.id);
      const ownCompetitorIds = new Set(ownSubmissions.map((submission) => submission.competitor_id));
      const allowedActiveDivisions = new Set((next.snapshot.assignments ?? [])
          .filter((assignment) => assignment.user_id === viewer.id)
        .map((assignment) => assignment.division));
      next = {
        ...next,
        snapshot: {
          ...next.snapshot,
          competitors: next.snapshot.competitors.filter((competitor) =>
            ownCompetitorIds.has(competitor.id) ||
            (competitor.status === "active" && allowedActiveDivisions.has(competitor.division)),
          ),
          submissions: ownSubmissions,
          profiles: undefined,
          audit: undefined,
          rankings: undefined,
          assignments: next.snapshot.assignments?.filter((assignment) => assignment.user_id === viewer.id),
        },
      };
    }
    await writeLocal(next.snapshot.profile.id, next);
    if (!demo) localStorage.setItem("hidc-last-user", next.snapshot.profile.id);
    ref.current = next;
    setWorkspace(next);
    if (demo) {
      void api("demo-scores", next.snapshot)
        .then((scores) => {
          if (ref.current === next) {
            const enriched = {
              ...next,
              snapshot: { ...next.snapshot, ...scores },
            };
            ref.current = enriched;
            setWorkspace(enriched);
          }
        })
        .catch(() => {});
    }
  }, []);
  const syncAppearance = useCallback(async () => {
    if (demo || !navigator.onLine || appearanceSyncBusy.current) return;
    const before = ref.current;
    const pending = before?.appearancePending;
    if (!before || !pending) return;
    appearanceSyncBusy.current = true;
    try {
      const result = await api("profile/appearance", {
        preferences: pending.preferences,
        updatedAt: pending.updatedAt,
      }, { method: "PATCH" }) as {
        preferences: AppearancePreferences;
        updatedAt: string;
        saved: boolean;
        conflict: boolean;
      };
      const current = ref.current;
      if (!current || current.snapshot.profile.id !== before.snapshot.profile.id) return;
      if (current.appearancePending?.updatedAt !== pending.updatedAt) return;
      const updated = {
        ...current,
        appearancePending: null,
        snapshot: {
          ...current.snapshot,
          profile: {
            ...current.snapshot.profile,
            appearance_preferences: result.preferences,
            appearance_updated_at: result.updatedAt,
          },
        },
      };
      await commit(updated);
      setAppearance(result.preferences);
      setThemePreference(result.preferences.mode);
      applyAppearance(result.preferences);
      setTheme(result.preferences.mode === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
        : result.preferences.mode);
      setAppearanceSyncError("");
      if (result.conflict) setNotice("A newer appearance saved on another device was applied.");
    } catch (error) {
      setAppearanceSyncError(`Appearance sync failed: ${(error as Error).message}`);
    } finally {
      appearanceSyncBusy.current = false;
    }
  }, [commit]);
  const hotkeySyncBusy = useRef(false);
  const syncHotkeys = useCallback(async () => {
    if (demo || !navigator.onLine || hotkeySyncBusy.current) return;
    const before = ref.current;
    const pending = before?.hotkeysPending;
    if (!before || !pending) return;
    hotkeySyncBusy.current = true;
    try {
      const result = await api("profile/hotkeys", {
        preferences: pending.preferences,
        updatedAt: pending.updatedAt,
      }, { method: "PATCH" }) as {
        preferences: { enabled: boolean; keys: Record<string, string> };
        updatedAt: string;
        saved: boolean;
        conflict: boolean;
      };
      const current = ref.current;
      if (!current || current.snapshot.profile.id !== before.snapshot.profile.id || current.hotkeysPending?.updatedAt !== pending.updatedAt) return;
      await commit({
        ...current,
        hotkeysPending: null,
        snapshot: { ...current.snapshot, profile: {
          ...current.snapshot.profile,
          hotkey_preferences: result.preferences,
          hotkeys_updated_at: result.updatedAt,
        } },
      });
      setHotkeys({ ...defaultKeys, ...result.preferences.keys });
      setKeysEnabled(result.preferences.enabled);
      if (result.conflict) setNotice("Newer hotkey settings saved on another device were applied.");
      setSyncError("");
    } catch (error) {
      setSyncError(`Hotkey sync failed: ${(error as Error).message}`);
    } finally {
      hotkeySyncBusy.current = false;
    }
  }, [commit]);
  const fetchState = useCallback(
    () =>
      api(
        "state",
        undefined,
        adminUnlocked && showPoints && adminUnlockToken
          ? { adminUnlockToken, showPoints: true }
          : undefined,
      ),
    [adminUnlocked, adminUnlockToken, showPoints],
  );
  const refresh = useCallback(async () => {
    if (demo || !navigator.onLine) return;
    // Keep sync and refresh serialized, but do not skip live state just because
    // this judge has score events queued locally.
    if (busy.current) {
      setRefreshQueued(true);
      return;
    }
    setRefreshQueued(false);
    busy.current = true;
    setRefreshingCompetitor(true);
    try {
      const snapshot: Snapshot = await fetchState();
      chain.current = chain.current.then(async () => {
        const current = ref.current;
        if (!current || current.snapshot.profile.id !== snapshot.profile.id) return;
        const reopenedSubmission = current.snapshot.submissions.find(
          (previous) => previous.user_id === current.snapshot.profile.id && previous.finished &&
            !current.queue.some((operation) => operation.competitor_id === previous.competitor_id) &&
            snapshot.submissions.some((next) => next.id === previous.id && !next.finished),
        );
        const merged = mergeRemoteSnapshotPreservingQueue(current, snapshot);
        await commit(merged);
        if (reopenedSubmission) {
          setNotice("The organizer reopened your score. Editing is available.");
        }
        if (!merged.queue.length) setSyncError("");
      });
      await chain.current;
    } catch (e) {
      const error = e as Error;
      setSyncError(
        error instanceof ApiResponseError && error.status === 401
          ? "Sign-in required. Your saved session was rejected; sign in again to reconnect."
          : !navigator.onLine || error instanceof TypeError
            ? "Connection lost. Any pending scores remain saved locally."
            : error.message,
      );
    } finally {
      busy.current = false;
      setRefreshingCompetitor(false);
    }
  }, [commit, fetchState]);
  const sync = useCallback(async () => {
    if (demo || busy.current || !navigator.onLine || !ref.current?.queue.length)
      return;
    busy.current = true;
    setSyncing(true);
    try {
      const serverVersions = new Map<string, number>();
      while (ref.current?.queue.length) {
        const entry = ref.current.queue[0];
        const expectedVersion = serverVersions.get(entry.competitor_id);
        const result = await api("sync", expectedVersion === undefined
          ? entry
          : { ...entry, expected_version: expectedVersion });
        if (Number.isInteger(result.version))
          serverVersions.set(entry.competitor_id, Number(result.version));
        const clientRevision = entry.scoring_config_revision ?? ref.current?.snapshot.scoringConfigRevision ?? 1;
        if (Number(result.scoringConfigRevision) > clientRevision) {
          setScoringReconciliationNotice(
            `An offline score selection from configuration v${clientRevision} was synced using current rules v${result.scoringConfigRevision}.`,
          );
        }
        if (result.legacyPerformancePayloadRecovered) {
          setNotice("A previously queued Performance update was safely recovered and synced.");
        }
        chain.current = chain.current.then(async () => {
          if (ref.current)
            await commit({
              ...ref.current,
              queue: ref.current.queue.filter((o) => o.id !== entry.id),
            });
        });
        await chain.current;
      }
      const snapshot: Snapshot = await fetchState();
      chain.current = chain.current.then(async () => {
        if (!ref.current?.queue.length) await commit({ snapshot, queue: [] });
      });
      await chain.current;
      setSyncError("");
    } catch (e) {
      setSyncError((e as Error).message);
    } finally {
      busy.current = false;
      setSyncing(false);
    }
  }, [commit, fetchState]);
  const reconcilePendingOfflineWork = useCallback(async () => {
    try {
      if (demo || !navigator.onLine) throw new Error("Reconnect before reconciling saved work.");
      const latest = ref.current;
      if (!latest?.queue.length) throw new Error("There is no saved work to reconcile.");
      const remote: Snapshot = await fetchState();
      const activeCompetitor = remote.competitors.find((competitor) => competitor.status === "active" && !competitor.archived);
      const scoringWindow = remote.scoringWindow;
      if (!activeCompetitor || scoringWindow?.competitor_id !== activeCompetitor.id || !scoringWindow.token || !scoringWindow.revision)
        throw new Error("The organizer has not reopened the queued competitor. Your saved work remains on this device.");
      if (!latest.queue.every((operation) => operation.competitor_id === activeCompetitor.id))
        throw new Error("This device has queued work for another competitor. Download a local backup and ask the organizer to reconcile it.");
      const submissionVersion = remote.submissions.find((submission) =>
        submission.competitor_id === activeCompetitor.id && submission.user_id === remote.profile.id)?.version ?? 0;
      const expectedVersion = submissionVersion;
      const queue = rebaseQueuedOperationsToOpenWindow(
        latest.queue,
        activeCompetitor.id,
        { revision: scoringWindow.revision, token: scoringWindow.token },
        expectedVersion,
      );
      if (!queue) throw new Error("Saved work includes another competitor and was left unchanged. Download a local backup and ask the organizer to reconcile it.");
      await commit({ ...mergeRemoteSnapshotPreservingQueue({ ...latest, queue }, remote), queue });
      setSyncError("");
      setNotice("Saved work is queued for the reopened competitor.");
      await sync();
      await refresh();
    } catch (error) {
      setSyncError((error as Error).message);
    }
  }, [commit, demo, fetchState, refresh, sync]);
  useEffect(() => {
    // Use the event default until this account's saved settings load.
    const preference: AppearancePreferences["mode"] = "light";
    setThemePreference(preference);
    const initialAppearance: AppearancePreferences = { ...defaultAppearance, mode: preference };
    setAppearance(initialAppearance);
    const applyPreference = () => {
      const effective = preference;
      setTheme(effective);
      applyAppearance(initialAppearance, effective);
    };
    applyPreference();
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator)
      void navigator.serviceWorker.register("/sw.js");
    setOnline(navigator.onLine);
    const connectivity = () => setOnline(navigator.onLine);
    window.addEventListener("online", connectivity);
    window.addEventListener("offline", connectivity);
    void (async () => {
      try {
        if (demo) {
          const id = localStorage.getItem("hidc-demo-user") ?? "demo-user-1";
          const local = await readLocal(id);
          await commit(local ?? { snapshot: blankDemo(), queue: [] });
          if (local) setTab(defaultScoreTab(local.snapshot));
        } else {
          if (!navigator.onLine) {
            const id = localStorage.getItem("hidc-last-user");
            const cached = id ? await readLocal(id) : undefined;
            if (cached) {
              await commit(cached);
              setTab(defaultScoreTab(cached.snapshot));
            }
            return;
          }
          const session = await supabase?.auth.getSession();
          if (session?.data.session) {
            const local = await readLocal(session.data.session.user.id);
            if (local) {
              await commit(local);
              setTab(defaultScoreTab(local.snapshot));
            }
            if (navigator.onLine && !local?.queue.length) {
              const snapshot: Snapshot = await api("state");
              await commit({ snapshot, queue: [] });
              setTab(defaultScoreTab(snapshot));
            }
          }
        }
      } catch (e) {
        setSyncError((e as Error).message);
      } finally {
        setReady(true);
      }
    })();
    return () => {
      window.removeEventListener("online", connectivity);
      window.removeEventListener("offline", connectivity);
    };
  }, [commit]);
  useEffect(() => {
    if (!profile) return;
    const preferences = normalizeAppearancePreferences(profile.appearance_preferences);
    setAppearance(preferences);
    setThemePreference(preferences.mode);
    const effective = preferences.mode === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : preferences.mode;
    setTheme(effective);
    applyAppearance(preferences, effective);
  }, [
    profile?.id,
    profile?.appearance_preferences?.template,
    profile?.appearance_preferences?.scheme,
    profile?.appearance_preferences?.font,
    profile?.appearance_preferences?.mode,
    profile?.appearance_preferences?.sidebarCollapsed,
  ]);
  useEffect(() => {
    if (!profile) return;
    const preferences = profile.hotkey_preferences;
    setHotkeys({ ...defaultKeys, ...(preferences?.keys ?? {}) });
    setKeysEnabled(preferences?.enabled ?? true);
  }, [profile?.id, profile?.hotkeys_updated_at, profile?.hotkey_preferences]);
  useEffect(() => {
    if (online && workspace?.appearancePending) void syncAppearance();
  }, [online, workspace?.snapshot.profile.id, workspace?.appearancePending?.updatedAt, syncAppearance]);
  useEffect(() => {
    if (online && workspace?.hotkeysPending) void syncHotkeys();
  }, [online, workspace?.snapshot.profile.id, workspace?.hotkeysPending?.updatedAt, syncHotkeys]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      if (themePreference !== "system") return;
      const effective = media.matches ? "dark" : "light";
      setTheme(effective);
      applyAppearance(appearance, effective);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [themePreference, appearance]);
  useEffect(() => {
    if (adminUnlocked && showPoints && state && !state.pointAccess) {
      setAdminUnlocked(false);
      setAdminUnlockToken(null);
      setShowPoints(false);
      setAdminPasswordError("Admin access expired. Enter the Admin password again.");
    }
  }, [adminUnlocked, showPoints, state?.pointAccess]);
  useEffect(() => {
    if (!ready || !state) return;
    const revalidate = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      // Stop periodic retries when the auth session is rejected. The visible
      // Retry action can still make one explicit check.
      if (syncError.startsWith("Sign-in required.")) return;
      if (ref.current?.queue.length) {
        if (syncError.startsWith("Scoring window closed.")) {
          // Keep the outbox untouched and check only for an Organizer reopen.
          // Do not retry the same stale authorization every poll interval.
          void refresh();
          return;
        }
        // Drain queued work first where possible, then merge a fresh snapshot
        // underneath any actions that still remain queued.
        void sync().then(() => refresh());
      } else {
        void refresh();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") revalidate();
    };
    const onOnline = () => revalidate();
    const timer = setInterval(() => {
      revalidate();
      void syncAppearance();
      void syncHotkeys();
    }, 10000);
    revalidate();
    void syncAppearance();
    const channel =
      !demo && supabase
        ? supabase
            .channel("roster")
            .on(
              "postgres_changes",
              { event: "UPDATE", schema: "public", table: "live_signal" },
              revalidate,
            )
            .subscribe((status) => {
              if (status === "SUBSCRIBED") revalidate();
            })
        : null;
    window.addEventListener("focus", revalidate);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", revalidate);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (channel) void supabase?.removeChannel(channel);
    };
  }, [ready, state?.profile.id, online, sync, refresh, syncAppearance, syncHotkeys, syncError]);
  useEffect(() => {
    if (refreshQueued && !syncing && !refreshingCompetitor && online) {
      void refresh();
    }
  }, [refreshQueued, syncing, refreshingCompetitor, online, refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  const persistAction = (
    kind: Operation["kind"],
    payload: Record<string, unknown>,
  ) => {
    if (!canScore || !current) return;
    const competitorId = current.id;
    const submitting = kind === "finish" && payload.finished === true;
    if (submitting) {
      setSubmittingCompetitors((previous) => new Set(previous).add(competitorId));
    }
    chain.current = chain.current.then(async () => {
      try {
        const latest = ref.current!;
        const s = latest.snapshot.submissions.find(
          (s) =>
            s.competitor_id === competitorId &&
            s.user_id === latest.snapshot.profile.id,
        );
        if (s?.finished) {
          throw new Error("This score has been submitted. Ask an organizer to reopen it.");
        }
        if (kind === "finish" && payload.finished !== true) {
          throw new Error("Submitted scores can only be reopened by an organizer.");
        }
        const op: Operation = {
          id: uid(),
          competitor_id: competitorId,
          expected_version: s?.version ?? 0,
          kind,
          payload,
          scoring_config_revision: latest.snapshot.scoringConfigRevision ?? 1,
          scoring_window_revision: latest.snapshot.scoringWindow?.competitor_id === competitorId
            ? latest.snapshot.scoringWindow.revision : undefined,
          scoring_window_token: latest.snapshot.scoringWindow?.competitor_id === competitorId
            ? latest.snapshot.scoringWindow.token : undefined,
        };
        if (!demo && (!op.scoring_window_revision || !op.scoring_window_token))
          throw new Error("The scoring window has not synced yet. Keep this page open and retry after the active competitor refreshes.");
        const snapshot = applyLocal(latest.snapshot, op);
        await commit({ snapshot, queue: demo ? [] : [...latest.queue, op] });
        setNotice(
          kind === "put_event"
            ? "Event recorded · saved on this laptop"
            : kind === "finish"
              ? "Submitted · saved on this laptop"
              : "Change saved on this laptop",
        );
      } catch (e) {
        setSyncError(
          `Local save failed: ${(e as Error).message}. Do not close this page.`,
        );
      } finally {
        if (submitting) {
          setSubmittingCompetitors((previous) => {
            const next = new Set(previous);
            next.delete(competitorId);
            return next;
          });
        }
      }
      void sync();
    });
  };
  useEffect(() => {
    setTrick("");
    setLevel(1);
    setExecution("E0");
    setFeatures([]);
    setEditing(null);
    if (!server) setSelected(active?.id ?? null);
  }, [active?.id, server]);
  const clear = () => {
    setTrick("");
    setLevel(1);
    setExecution("E0");
    setFeatures([]);
    setEditing(null);
  };
  const submit = () => {
    if (!trick || !canScore || Date.now() - lastSubmit.current < 250) return;
    lastSubmit.current = Date.now();
    persistAction("put_event", {
      id: editing?.id ?? uid(),
      trick,
      level,
      features: deductions.includes(trick) ? [] : features,
      ...(!deductions.includes(trick) ? { execution } : {}),
      at: editing?.at ?? new Date().toISOString(),
    });
    clear();
  };
  const remove = (event: Event) =>
    setModal({
      title: "Remove This Event?",
      body: `${event.trick} will be removed from the sequence. Its history remains in the audit log.`,
      action: () => persistAction("delete_event", { id: event.id }),
    });
  const finish = () => {
    if (!canScore) return;
    setModal({
      title: "Submit Score?",
      body: "Submit your score for this competitor? You will not be able to make further edits unless an organizer reopens it.",
      action: () => persistAction("finish", { finished: true }),
      confirmLabel: "Submit",
    });
  };
  const toggleFeature = (f: string) =>
    setFeatures((prev) =>
      prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f],
    );
  useEffect(() => {
    let prefix = "";
    let last = 0;
    const listener = (e: KeyboardEvent) => {
      if (
        !keysEnabled ||
        settingsOpen ||
        modal ||
        competitorEdit ||
        userEdit ||
        tab !== "Technical" ||
        !canScore ||
        (e.target instanceof HTMLElement &&
          ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName))
      )
        return;
      if (e.repeat) return;
      let key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (e.code.startsWith("Digit") && e.shiftKey) key = e.code.slice(5);
      if (e.shiftKey) key = `Shift+${key}`;
      if (e.altKey) key = `Alt+${key}`;
      if (e.ctrlKey || e.metaKey) return;
      const combined = Date.now() - last < 900 ? prefix + key : key;
      const action = matchHotkeyAction(hotkeys, combined, key);
      prefix = key;
      last = Date.now();
      if (!action) return;
      e.preventDefault();
      prefix = "";
      if (action === "submit") submit();
      else if (action === "clear") clear();
      else if (action === "finish") finish();
      else if (action === "undo" && own?.events.length)
        remove(own.events[own.events.length - 1]);
      else if (action === "level:next") setLevel((current) => stepTechnicalLevel(current, 1));
      else if (action === "level:previous") setLevel((current) => stepTechnicalLevel(current, -1));
      else if (action.startsWith("level:"))
        setLevel(Number(action.split(":")[1]));
      else if (action.startsWith("execution:")) {
        const nextExecution = action.slice("execution:".length);
        if (executionOptions.includes(nextExecution as (typeof executionOptions)[number]))
          setExecution(nextExecution as (typeof executionOptions)[number]);
      }
      else if (action.startsWith("tab:")) setTab(action.slice(4));
      else if (["T1", "T2", "T3", "A"].includes(action)) toggleFeature(action);
      else setTrick(action);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setLoginBusy(true);
    try {
      if (!supabase)
        throw new Error(
          "Set Supabase environment variables, or enable local demo mode.",
        );
      const session = await api("login", { username, password });
      const { error } = await supabase.auth.setSession(session);
      if (error) throw error;
      const snapshot: Snapshot = await api("state");
      const local = await readLocal(snapshot.profile.id);
      await commit(local?.queue.length ? local : { snapshot, queue: [] });
      setTab(defaultScoreTab(snapshot));
      setPassword("");
      setSyncError("");
    } catch (e) {
      setSyncError((e as Error).message);
    } finally {
      setLoginBusy(false);
    }
  }
  function openProfileSettings() {
    setSettingsSection("account");
    setProfileName(profile?.name ?? "");
    setProfileUsername(profile?.username ?? "");
    setCurrentPassword("");
    setNewLoginPassword("");
    setConfirmLoginPassword("");
    setProfileMessage("");
    setProfileMessageError(false);
    setAppearanceSyncError("");
    setSettingsOpen(true);
  }
  function openSettingsSection(section: "account" | "appearance" | "hotkeys" | "privacy" | "session") {
    setSettingsSection(section);
    setProfileName(profile?.name ?? "");
    setProfileUsername(profile?.username ?? "");
    setCurrentPassword("");
    setNewLoginPassword("");
    setConfirmLoginPassword("");
    setProfileMessage("");
    setProfileMessageError(false);
    setSettingsOpen(true);
  }
  async function saveAppearancePreferences(preferences: AppearancePreferences): Promise<AppearanceSaveResult> {
    const current = ref.current;
    if (!current || !profile || current.snapshot.profile.id !== profile.id)
      throw new Error("Sign in again before saving appearance settings.");
    const offline = demo || !navigator.onLine || !online;
    const updatedAt = new Date().toISOString();
    let result: AppearanceSaveResult = {
      preferences,
      updatedAt,
      saved: true,
      conflict: false,
      offline,
    };
    if (!offline) {
      const response = await api("profile/appearance", { preferences, updatedAt }, { method: "PATCH" });
      result = {
        preferences: response.preferences,
        updatedAt: response.updatedAt,
        saved: response.saved,
        conflict: response.conflict,
        offline: false,
      };
    }
    const latest = ref.current;
    if (!latest || latest.snapshot.profile.id !== profile.id)
      throw new Error("Your signed-in account changed before the appearance could be saved.");
    const next: LocalWorkspace = {
      ...latest,
      appearancePending: !demo && offline
        ? { preferences: result.preferences, updatedAt: result.updatedAt }
        : null,
      snapshot: {
        ...latest.snapshot,
        profile: {
          ...latest.snapshot.profile,
          appearance_preferences: result.preferences,
          appearance_updated_at: result.updatedAt,
        },
      },
    };
    await commit(next);
    setAppearanceSyncError("");
    previewAppearance(result.preferences);
    if (result.conflict) setNotice("A newer appearance saved on another device was kept.");
    return result;
  }
  async function saveHotkeyPreferences() {
    if (!profile || !ref.current) return;
    const values = Object.values(hotkeys).map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (new Set(values).size !== values.length) {
      setSyncError("Hotkeys must be unique. Resolve duplicate bindings before saving.");
      return;
    }
    const previous = Date.parse(profile.hotkeys_updated_at ?? "1970-01-01T00:00:00.000Z");
    const updatedAt = new Date(Math.max(Date.now(), previous + 1)).toISOString();
    const preferences = { enabled: keysEnabled, keys: { ...hotkeys } };
    try {
      let savedPreferences = preferences;
      let savedAt = updatedAt;
      let conflict = false;
      if (!demo && online) {
        const result = await api("profile/hotkeys", { preferences, updatedAt }, { method: "PATCH" }) as {
          preferences: typeof preferences; updatedAt: string; conflict: boolean;
        };
        savedPreferences = result.preferences;
        savedAt = result.updatedAt;
        conflict = result.conflict;
      }
      const latest = ref.current;
      if (!latest || latest.snapshot.profile.id !== profile.id)
        throw new Error("Your signed-in account changed before the hotkeys could be saved.");
      await commit({
        ...latest,
        hotkeysPending: !demo && !online ? { preferences, updatedAt } : null,
        snapshot: { ...latest.snapshot, profile: {
          ...latest.snapshot.profile,
          hotkey_preferences: savedPreferences,
          hotkeys_updated_at: savedAt,
        } },
      });
      setHotkeys({ ...defaultKeys, ...savedPreferences.keys });
      setKeysEnabled(savedPreferences.enabled);
      setNotice(conflict
        ? "Newer hotkey settings saved on another device were applied."
        : !online && !demo
          ? "Hotkeys saved locally and will sync when the connection returns."
          : "Hotkeys saved to your judge profile.");
      setSyncError("");
    } catch (error) {
      setSyncError(`Hotkey settings could not be saved: ${(error as Error).message}`);
    }
  }

  async function saveProfileSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!profile || !workspace) return;
    setProfileMessage("");
    setProfileMessageError(false);
    const usernameChanged = profileUsername.trim().toLowerCase() !== profile.username;
    const passwordError = profilePasswordError(newLoginPassword, confirmLoginPassword);
    if (passwordError) {
      setProfileMessage(passwordError);
      setProfileMessageError(true);
      return;
    }
    if (!demo && !online) {
      setProfileMessage("Connect to the server before changing profile details.");
      setProfileMessageError(true);
      return;
    }
    if (demo && (usernameChanged || newLoginPassword)) {
      setProfileMessage("Login credentials can only be changed on the connected site.");
      setProfileMessageError(true);
      return;
    }
    const protectedChange = usernameChanged || !!newLoginPassword;
    if (!demo && protectedChange && !currentPassword) {
      setProfileMessage("Enter your current password to change your username or password.");
      setProfileMessageError(true);
      return;
    }
    setProfileBusy(true);
    try {
      if (demo) {
        const next = structuredClone(ref.current!);
        next.snapshot.profile.name = profileName.trim();
        await commit(next);
      } else {
        const payload: Record<string, string> = {
          name: profileName,
          username: profileUsername,
        };
        if (protectedChange) payload.currentPassword = currentPassword;
        if (newLoginPassword) payload.newPassword = newLoginPassword;
        await api("profile", payload, { method: "PATCH" });
        const snapshot: Snapshot = await fetchState();
        await commit({ snapshot, queue: ref.current?.queue ?? [] });
      }
      setCurrentPassword("");
      setNewLoginPassword("");
      setConfirmLoginPassword("");
      setProfileMessage("Your profile was updated.");
      setNotice("Profile updated");
    } catch (e) {
      setProfileMessage((e as Error).message);
      setProfileMessageError(true);
    } finally {
      setProfileBusy(false);
    }
  }
  async function changeAvatar(file?: File) {
    if (!profile || !file) return;
    setProfileMessage("");
    setProfileMessageError(false);
    if (!online || demo) {
      setProfileMessage("Avatar changes require an online account on the connected site.");
      setProfileMessageError(true);
      return;
    }
    if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type)) {
      setProfileMessage("Choose a JPEG, PNG, or WebP image.");
      setProfileMessageError(true);
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setProfileMessage("The image must be no larger than 2 MB.");
      setProfileMessageError(true);
      return;
    }
    setProfileBusy(true);
    try {
      const session = await supabase?.auth.getSession();
      const body = new FormData();
      body.set("avatar", file);
      const response = await fetch("/api/profile/avatar", {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.data.session?.access_token ?? ""}` },
        body,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Avatar upload failed.");
      const snapshot: Snapshot = await fetchState();
      await commit({ snapshot, queue: ref.current?.queue ?? [] });
      setProfileMessage("Profile picture updated.");
      setNotice("Profile picture updated");
    } catch (e) {
      setProfileMessage((e as Error).message);
      setProfileMessageError(true);
    } finally {
      setProfileBusy(false);
    }
  }
  async function removeAvatar() {
    if (!profile || !online || demo) return;
    setProfileBusy(true);
    try {
      const session = await supabase?.auth.getSession();
      const response = await fetch("/api/profile/avatar", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session?.data.session?.access_token ?? ""}` },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not remove picture.");
      const snapshot: Snapshot = await fetchState();
      await commit({ snapshot, queue: ref.current?.queue ?? [] });
      setProfileMessage("Profile picture removed.");
      setNotice("Profile picture removed");
    } catch (e) {
      setProfileMessage((e as Error).message);
      setProfileMessageError(true);
    } finally {
      setProfileBusy(false);
    }
  }
  async function signOut() {
    if (workspace?.queue.length) {
      setSyncError("Sync pending changes before signing out.");
      return;
    }
    localStorage.removeItem("hidc-last-user");
    await supabase?.auth.signOut();
    ref.current = null;
    setWorkspace(null);
    setSettingsOpen(false);
    setAdminUnlockToken(null);
    setAdminUnlocked(false);
    setShowPoints(false);
    previewAppearance(defaultAppearance);
  }
  async function clearOwnOfflineCache() {
    if (!profile || !workspace || workspace.queue.length) return;
    await clearLocal(profile.id);
    await signOut();
    setNotice("Your offline cache was cleared.");
  }
  async function verifyAdminPassword(e: React.FormEvent) {
    e.preventDefault();
    setAdminPasswordError("");
    if (!navigator.onLine) {
      setAdminPasswordError("Admin unlock requires connection. Reconnect and try again.");
      return;
    }
    setAdminPasswordBusy(true);
    try {
      const result = await api("verify-admin", { password: adminPassword });
      if (!result.unlockToken)
        throw new Error("The server did not provide an Admin unlock.");
      setAdminUnlockToken(result.unlockToken);
      setAdminUnlocked(true);
      setShowPoints(false);
      setAdminPassword("");
      setSyncError("");
    } catch (e) {
      const error = e as Error;
      setAdminPasswordError(
        !navigator.onLine || error instanceof TypeError
          ? "Admin unlock requires connection. Reconnect and try again."
          : error instanceof ApiResponseError && error.status === 401 && error.message === "Sign in required"
            ? "Your sign-in session is no longer valid. Sign in again to unlock Admin."
            : error.message,
      );
    } finally {
      setAdminPasswordBusy(false);
    }
  }
  async function toggleShowPoints() {
    if (!adminUnlocked || !adminUnlockToken || !profile) return;
    if (showPoints) {
      setShowPoints(false);
      try {
        const snapshot: Snapshot = await api("state");
        await commit({ snapshot, queue: ref.current?.queue ?? [] });
      } catch (error) {
        setSyncError((error as Error).message);
      }
      return;
    }
    try {
      const snapshot: Snapshot = await api("state", undefined, {
        adminUnlockToken,
        showPoints: true,
      });
      if (!snapshot.pointAccess) {
        setAdminUnlocked(false);
        setAdminUnlockToken(null);
        throw new Error("Admin access expired. Enter the Admin password again.");
      }
      await commit({ snapshot, queue: ref.current?.queue ?? [] });
      setShowPoints(true);
    } catch (error) {
      setShowPoints(false);
      const failure = error as Error;
      setAdminPasswordError(
        !navigator.onLine || failure instanceof TypeError
          ? "Admin unlock requires connection. Reconnect and try again."
          : failure instanceof ApiResponseError && failure.status === 401 && failure.message === "Sign in required"
            ? "Your sign-in session is no longer valid. Sign in again to view points."
            : failure.message,
      );
    }
  }
  function lockAdmin() {
    setAdminUnlocked(false);
    setAdminUnlockToken(null);
    setShowPoints(false);
    setAdminPassword("");
    setAdminPasswordError("");
    void api("state")
      .then((snapshot: Snapshot) =>
        commit({ snapshot, queue: ref.current?.queue ?? [] }),
      )
      .catch((error) => setSyncError((error as Error).message));
  }
  async function changeAdminTabPassword(e: React.FormEvent) {
    e.preventDefault();
    setAdminTabPasswordMessage("");
    if (newAdminTabPassword !== confirmAdminTabPassword) {
      setAdminTabPasswordMessage("The new passwords do not match.");
      return;
    }
    try {
      if (demo)
        throw new Error("Changing the shared password requires the live site.");
      await api("admin-tab-password", { password: newAdminTabPassword });
      setNewAdminTabPassword("");
      setConfirmAdminTabPassword("");
      setAdminTabPasswordMessage("Shared Admin-tab password updated.");
    } catch (e) {
      setAdminTabPasswordMessage((e as Error).message);
    }
  }
  async function manage(action: string, data: unknown) {
    try {
      if (demo) {
        const next = structuredClone(ref.current!);
        const d = data as Competitor;
        if (action === "activate") {
          next.snapshot.competitors.forEach((c) => {
            if (c.status === "active") c.status = "locked";
            if (c.id === d.id) c.status = "active";
          });
        } else if (action === "lock") {
          next.snapshot.competitors.find((c) => c.id === d.id)!.status =
            "locked";
        } else if (action === "delete") {
          const target = data as { id: string };
          next.snapshot.competitors = next.snapshot.competitors.filter((competitor) => competitor.id !== target.id);
          next.snapshot.submissions = next.snapshot.submissions.filter((submission) => submission.competitor_id !== target.id);
          next.snapshot.competitors
            .sort((a, b) => a.position - b.position)
            .forEach((competitor, index) => { competitor.position = index + 1; });
        } else if (action === "save") {
          const index = next.snapshot.competitors.findIndex(
            (c) => c.id === d.id,
          );
          if (index < 0) next.snapshot.competitors.push({ ...d, id: uid() });
          else next.snapshot.competitors[index] = d;
        } else if (action === "assignments") {
          const assignment = data as { division: string; assignments: { slot: number; user_id: string; scoring_type: ScoringType }[] };
          next.snapshot.assignments = [
            ...(next.snapshot.assignments ?? []).filter((row) => row.division !== assignment.division),
            ...assignment.assignments.map((row) => ({ ...row, division: assignment.division })),
          ];
        } else if (["user", "create_user", "update_user", "remove_user", "remove_division"].includes(action))
          throw new Error(
            "This action requires a connected Supabase project.",
          );
        await commit(next);
      } else {
        const result = await api("manage", { action, data });
        if (action === "remove_user") {
          setNotice((result as { submittedScoresPreserved?: boolean })?.submittedScoresPreserved
            ? "Account permanently deleted. Submitted scores were preserved for authorized event records."
            : "Account and login permanently deleted.");
        } else if (action === "remove_division") {
          const impact = (result as { divisionOutcome?: { competitors?: number; submitted_scores?: number } })?.divisionOutcome;
          setNotice(`Division deleted. Removed ${impact?.competitors ?? 0} competitors and ${impact?.submitted_scores ?? 0} submitted scores.`);
        } else if (action === "reactivate_user") setNotice("Legacy archived account reactivated.");
        else setNotice(action === "create_user" ? "Account created." : action === "update_user" ? "Account updated." : action === "assignments" ? "Division assignments saved." : action === "delete" ? "Competitor and saved scores deleted" : "Changes saved");
        try {
          await refresh();
        } catch (refreshError) {
          if (action === "create_user" || action === "update_user") {
            setNotice(action === "create_user"
              ? "Account created. The account list could not refresh yet."
              : "Account updated. The account list could not refresh yet.");
          } else if (action === "remove_division") {
            setNotice("Division deleted. The server view could not refresh yet; retry sync to update progress and rankings.");
          } else {
            throw refreshError;
          }
          setSyncError((refreshError as Error).message);
        }
      }
      setCompetitorEdit(null);
      setUserEdit(null);
      setAccountFormError("");
      if (demo) setNotice(action === "delete" ? "Competitor and saved scores deleted" : "Changes saved");
      setAccountDeleteTarget(null);
      setAccountDeleteConfirmation("");
      if (action === "remove_division") {
        setDivisionDeleteTarget("");
        setDivisionDeleteConfirmation("");
        setAssignmentDraft(null);
      }
      return true;
    } catch (e) {
      if (action === "create_user" || action === "update_user")
        setAccountFormError((e as Error).message);
      else setSyncError((e as Error).message);
      return false;
    }
  }
  async function addDivision(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = newDivision.trim();
    if (!name) return;
    if (allDivisions.some((division) => division.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setSyncError("That division already exists. Select it from the Division list instead.");
      return;
    }
    if (await manage("division", { name })) {
      setNewDivision("");
      setDivisionFormOpen(false);
    }
  }
  async function switchDemo(value: string) {
    const role = value as Profile["role"];
    const snapshot = blankDemo(role);
    const local = await readLocal(snapshot.profile.id);
    await commit(local ?? { snapshot, queue: [] });
    localStorage.setItem("hidc-demo-user", snapshot.profile.id);
    setAdminUnlockToken(null);
    setAdminUnlocked(false);
    setShowPoints(false);
    setSelected(null);
    setTab(defaultScoreTab(local?.snapshot ?? snapshot));
    clear();
  }
  const exportPersonal = (format: "csv" | "txt", ranked: boolean) => {
    const rows = (state?.personal ?? [])
      .map((r) => {
        const c = state!.competitors.find((c) => c.id === r.competitor_id)!;
        return {
      Rank: r.rank,
          Competitor: c.name,
          Division: c.division,
          Order: c.position,
          Submitted:
            state!.submissions.find(
              (s) => s.competitor_id === c.id && s.user_id === profile?.id,
            )?.submitted_at ?? "",
          ...(technical ? {} : { Score: canViewPersonalPoints(r.competitor_id) ? r.total : "***" }),
        };
      })
      .filter((r) => filter === "All divisions" || r.Division === filter)
      .sort((a, b) =>
        ranked
          ? a.Division.localeCompare(b.Division) || a.Rank - b.Rank
          : a.Submitted.localeCompare(b.Submitted),
      );
    download(rows, format, ranked ? "personal-ranked" : "personal-order");
  };
  const exports = (handler: (f: "csv" | "txt", ranked: boolean) => void) => (
    <div className="exports">
      {(["csv", "txt"] as const).flatMap((f) =>
        [true, false].map((r) => (
          <button key={`${f}${r}`} onClick={() => handler(f, r)}>
            <Download size={14} />
            {r ? "Ranked" : "Submission order"} {f.toUpperCase()}
          </button>
        )),
      )}
    </div>
  );

  if (!ready)
    return (
      <div className="loading">
        <Activity />
        <h2>Opening Judge Console</h2>
        <p>Restoring your locally saved workspace…</p>
      </div>
    );
  if (!state)
    return (
      <main className="login" data-theme="light">
        <div className="login-card">
          <div className="brand">
            <Image
              className="brand-logo"
              src="/ndl-emblem.jpg"
              width={56}
              height={56}
              alt="National Diabolo League"
            />
            <strong>
              HIDC <em>2026</em>
            </strong>
          </div>
          <span className="eyebrow">
            HOUSTON INTERNATIONAL DIABOLO COMPETITION
          </span>
          <form onSubmit={login}>
            <label>
              Username
              <input
                type="text"
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label>
              Password
              <PasswordField
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button className="primary" disabled={loginBusy}>
              {loginBusy ? "Signing in…" : "Open Judge Console"}
              <ArrowRight size={18} />
            </button>
          </form>
          {syncError && <p className="error">{syncError}</p>}
        </div>
      </main>
    );
  const nav = [
    ...(server ? ["Server Access Control"] : []),
    ...(profile ? scoringTabs(profile) : []),
    "Score Details",
    "Saved Competitors",
    "Rankings",
    "Admin",
  ];
  return (
    <div className="app-shell" data-template={appearance.template} data-sidebar-collapsed={String(appearance.sidebarCollapsed)}>
      <header>
        <button
          className="brand"
          title="Toggle Light / Dark Theme"
          onClick={() => {
            const next = theme === "dark" ? "light" : "dark";
            changeThemePreference(next);
          }}
        >
          <img
            className="brand-logo"
            src="/ndl-emblem.jpg"
            width={56}
            height={56}
            alt="National Diabolo League"
          />
          <strong>
            HIDC <em>2026</em>
          </strong>
          <span className="brand-divider" />
          <span className="brand-description">
            HOUSTON INTERNATIONAL
            <br />
            DIABOLO COMPETITION
          </span>
        </button>
        <div className="header-right">
          {appearance.template === "sidebar-workspace" ? (
            <button
              type="button"
              className="sidebar-toggle navigation-toggle"
              aria-label={appearance.sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
              aria-expanded={!appearance.sidebarCollapsed}
              aria-controls="app-navigation"
              onClick={() => {
                const next = { ...appearance, sidebarCollapsed: !appearance.sidebarCollapsed };
                previewAppearance(next);
                void saveAppearancePreferences(next).catch((error) => {
                  setSyncError(`Appearance could not be saved: ${(error as Error).message}`);
                });
              }}
            >
              <PanelLeft size={17} aria-hidden="true" />
              <span>{appearance.sidebarCollapsed ? "Show Navigation" : "Hide Navigation"}</span>
            </button>
          ) : null}
          <span className={`connection ${!online ? "offline" : ""}`}>
            {online ? <Cloud size={16} /> : <CloudOff size={16} />}{" "}
            {demo
              ? "Local demo"
              : !online
                ? "Offline · saving locally"
                : syncing
                  ? "Syncing…"
                : workspace.queue.length
                    ? `${workspace.queue.length} pending`
                    : workspace.appearancePending
                      ? "Appearance pending sync"
                    : "Connected"}
          </span>
          <button
            className="profile-trigger"
            aria-label="Open profile and settings"
            title="Profile & Settings"
            onClick={openProfileSettings}
          >
            <span className="avatar">
              {profile?.avatar_url ? (
                <img src={profile.avatar_url} alt="" />
              ) : (
                (profile?.name ?? "?").trim().split(/\s+/).slice(0, 2).map((n) => n[0]?.toUpperCase()).join("")
              )}
            </span>
          </button>
          <div className="identity">
            <b>{profile?.name}</b>
            <span>
              {profile ? profileRoleLabel(profile, assignmentScoringType(currentAssignment, profile)) : ""}
            </span>
          </div>
          <button
            className="icon"
            title="Sign Out"
            onClick={() => void signOut()}
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>
      <nav
        id="app-navigation"
        aria-label="Main navigation"
        className={`navigation-menu ${appearance.template === "sidebar-workspace" && !appearance.sidebarCollapsed ? "sidebar-open" : ""}`}
      >
        {nav.map((name) => (
          <button
            key={name}
            className={tab === name ? "active" : ""}
            onClick={() => {
              if (name === "Admin") {
                setAdminPasswordError("");
              }
              setTab(name);
              setSelected(null);
              clear();
            }}
          >
            {name === "Technical" ? (
              <SlidersHorizontal size={16} />
            ) : name === "Performance" ? (
              <Activity size={16} />
            ) : name === "Saved Competitors" ? (
              <Users size={16} />
            ) : name === "Rankings" ? (
              <Trophy size={16} />
            ) : name === "Score Details" ? (
              <Layers size={16} />
            ) : (
              <Shield size={16} />
            )}
            <span>{name}</span>
          </button>
        ))}
        <span className="nav-end">
          JUDGE CONSOLE <b>2026</b>
        </span>
      </nav>
      {scoringReconciliationNotice ? (
        <div className="point-sync-reconciliation" role="status">
          <span>{scoringReconciliationNotice}</span>
          <button type="button" aria-label="Dismiss scoring configuration notice" onClick={() => setScoringReconciliationNotice("")}>Dismiss</button>
        </div>
      ) : null}
      {demo && (
        <div className="demo-bar">
          <span>
            <b>DEMO WORKSPACE</b> · Data stays on this laptop. Live competition
            requires Supabase setup.
          </span>
          <select
            aria-label="Demo account"
            value={profile?.role ?? "technical_judge"}
            onChange={(e) => void switchDemo(e.target.value)}
          >
            <option value="technical_judge">Technical Judge</option>
            <option value="performance_judge">Performance Judge</option>
            <option value="organizer">Organizer</option>
          </select>
        </div>
      )}
      {syncError && (
        <div className="alert" role="alert">
          <span>
            {syncError}
            {!!workspace.queue.length && <small> Your score is safely stored locally until sync succeeds.</small>}
          </span>
          <button
            onClick={() => {
              setSyncError("");
              if (workspace.queue.length) void sync().then(() => refresh());
              else void refresh();
            }}
          >
            Retry Sync
          </button>
          {canReconcilePendingWindow && (
            <button
              onClick={() => setModal({
                title: "Reconcile Saved Work?",
                body: `The organizer reopened ${active?.name ?? "this competitor"}. Re-apply this device’s pending actions to the currently open scoring window? The server will assign receipt times; local device timestamps are not proof of when an action happened. Only proceed if this saved work is the judge’s intended score for the reopened competitor.`,
                confirmLabel: "Reconcile and Sync",
                action: () => void reconcilePendingOfflineWork(),
              })}
            >
              Reconcile Reopened Score
            </button>
          )}
          <button
            onClick={() =>
              download(
                [{ workspace: JSON.stringify(sanitizeWorkspace(workspace)) }],
                "txt",
                "local-backup",
              )
            }
          >
            Download Local Backup
          </button>
          {workspace.queue.length > 0 && (
            <button
              onClick={() =>
                setModal({
                  title: "Reload the Server Copy?",
                  body: "Download your local backup first. This discards pending changes on this laptop and loads the current server entries. Use the backup to reconcile any missing events.",
                  action: () => {
                    void api("state")
                      .then((snapshot: Snapshot) =>
                        commit({ snapshot, queue: [] }),
                      )
                      .then(() => setSyncError(""))
                      .catch((e) => setSyncError(e.message));
                  },
                })
              }
            >
              Resolve Conflict
            </button>
          )}
          <button onClick={() => setSyncError("")} aria-label="Dismiss error">
            <X size={16} />
          </button>
        </div>
      )}
      <main className="workspace">
        <div className="page-heading">
          <div>
            <div className="eyebrow">
              COMPETITION WORKSPACE <span>/</span>{" "}
              {profile ? profileRoleLabel(profile, assignmentScoringType(currentAssignment, profile)).toUpperCase() : ""}
            </div>
            <h1>
              {tab === "Technical"
                  ? "Technical Scoring"
                : tab === "Performance"
                  ? "Performance Scoring"
                  : tab}
            </h1>
          </div>
          <div className="heading-actions">
            {(tab === "Technical" || tab === "Performance") && (
              <>
                <span className="session-tag">
                  <Radio size={14} /> LIVE SESSION
                </span>
                {tab === "Technical" && (
                  <button onClick={() => openSettingsSection("hotkeys")}>
                    <Keyboard size={16} /> Hotkeys <kbd>?</kbd>
                  </button>
                )}
                {refreshingCompetitor && (
                  <span className="live-refreshing" role="status" aria-live="polite">
                    <Activity size={14} /> Checking live floor…
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        {(tab === "Technical" || tab === "Performance") && (
          <>
            <section className="competitor-strip">
              <div className="competitor-number">
                {String(current?.position ?? 0).padStart(2, "0")}
              </div>
              <div className="competitor-name">
                <div className="eyebrow">
                  {selected ? "SAVED COMPETITOR" : "ON THE FLOOR"}
                  <span
                    className={`pill ${current?.status === "active" ? "live" : ""}`}
                  >
                    {current?.status === "active"
                      ? "Active routine"
                      : (current?.status ?? "Waiting")}
                  </span>
                </div>
                <h2>{current?.name ?? "Waiting for the next competitor"}</h2>
                <span>
                  {current?.division ??
                    "The organizer will activate a routine shortly."}
                </span>
              </div>
              <div className="routine-meta">
                <span>YOUR SUBMISSION</span>
                <b>
                  {submissionSubmitted
                    ? "Submitted"
                    : own
                      ? "In progress"
                      : "Not started"}
                </b>
              </div>
              <div className="strip-actions">
                {server && (
                  <label>
                    View judge{" "}
                    <select
                      aria-label="View judge submission"
                      value={viewingJudgeId}
                      onChange={(e) => {
                        if (tab === "Technical") setTechnicalViewJudgeId(e.target.value);
                        else setPerformanceViewJudgeId(e.target.value);
                        clear();
                      }}
                    >
                      {currentRoleAssignments.map((assignment) => (
                          <option value={assignment.user_id} key={assignment.user_id}>
                            {state?.profiles?.find((candidate) => candidate.id === assignment.user_id)?.name ?? assignment.display_name ?? "Former judge"}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                {submissionSubmitted ? (
                  <span className="submission-locked-label" role="status" aria-live="polite">
                    <Lock size={15} /> Submitted — Waiting for the next competitor
                  </span>
                ) : (
                  <>
                    <button
                      disabled={!canScore}
                      onClick={() => {
                        setNotice(
                          "All changes are saved automatically on this laptop.",
                        );
                        void sync();
                      }}
                    >
                      <Save size={16} /> Save
                    </button>
                    <button
                      className="primary"
                      disabled={!canScore}
                      onClick={finish}
                    >
                      Submit <Check size={17} />
                    </button>
                  </>
                )}
                <span className={`scoring-sync-state ${syncing ? "syncing" : syncError && workspace.queue.length ? "attention" : workspace.queue.length || demo ? "local" : "synced"}`} role="status" aria-live="polite">
                  {syncing ? <Activity size={15} /> : syncError && workspace.queue.length ? <CloudOff size={15} /> : workspace.queue.length || demo ? <Save size={15} /> : <CheckCircle2 size={15} />}
                  {syncStatus}
                </span>
                {syncError && workspace.queue.length > 0 && (
                  <button className="sync-retry" disabled={!online || syncing} onClick={() => void sync()}>
                    Retry Sync
                  </button>
                )}
              </div>
            </section>
            {!active && (
              <section className="panel scoring-empty-state" role="status" aria-live="polite">
                <div>
                  <h2>No competitor is currently available for scoring.</h2>
                  {refreshingCompetitor && <p className="muted">Checking for the next competitor…</p>}
                  {server ? (
                    <p>Use Server Access Control to create a competitor or activate the next one.</p>
                  ) : (
                    <p>Scoring will become available when the organizer starts the next competitor.</p>
                  )}
                </div>
                {server && (
                  <button type="button" onClick={() => setTab("Server Access Control")}>
                    Open Server Access Control <ArrowRight size={15} />
                  </button>
                )}
              </section>
            )}
            {tab === "Technical" ? (
              <div className="technical-layout">
                <aside className="sequence panel">
                  <div className="panel-heading">
                    <h3>
                      <PanelLeft size={16} /> Trick Sequence
                    </h3>
                    <span className="count">
                      {displayed?.events.length ?? 0}
                    </span>
                  </div>
                  <div className="sequence-list">
                    {!displayed?.events.length ? (
                      <div className="empty-sequence">
                        <Layers size={28} />
                        <h4>No Events Yet</h4>
                        <span>
                          Select a trick to begin <ArrowRight size={13} />
                        </span>
                      </div>
                    ) : (
                      displayed.events.map((event, i) => (
                        <div
                          key={event.id}
                          data-category={
                            deductions.includes(event.trick)
                              ? "deduction"
                              : event.trick.split(" ")[0]
                          }
                          className={`sequence-event ${deductions.includes(event.trick) ? "deduction" : ""} ${editing?.id === event.id ? "editing" : ""}`}
                        >
                          <span className="event-index">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <div>
                            <b>{event.trick}</b>
                            {!deductions.includes(event.trick) && (
                              <span>
                                L{event.level}
                                {event.features.length
                                  ? " · " + event.features.join(" · ")
                                  : ""}
                                {" · " + executionControlLabels[event.execution ?? "E0"]}
                              </span>
                            )}
                            <small>
                              {new Date(event.at).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit",
                              })}
                            </small>
                          </div>
                        <span className="event-points" aria-label="Event points">
                          {canViewPoints
                            ? event.value === undefined ? "***" : fmt(event.value)
                            : "***"}
                        </span>
                          <button
                            className="icon"
                            title={`Edit event ${i + 1}`}
                            disabled={!canScore}
                            onClick={() => {
                              setEditing(event);
                              setTrick(event.trick);
                              setLevel(event.level);
                              setFeatures(event.features);
                              setExecution(event.execution ?? "E0");
                            }}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            className="icon"
                            title={`Remove event ${i + 1}`}
                            disabled={!canScore}
                            onClick={() => remove(event)}
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="sequence-footer">
                    <Shield size={15} />
                    <span>Technical Total</span>
                    <b>{canViewPoints && displayed?.total !== undefined ? fmt(displayed.total) : "***"}</b>
                  </div>
                </aside>
                  <div className="scoring-controls">
                  {submissionSubmitted ? (
                    <section className="panel submission-locked-state" role="status" aria-live="polite">
                      <Lock size={18} />
                      <div>
                        <strong>Submitted — Waiting for the next competitor</strong>
                        <span>Your score is locked. An organizer can reopen it if a correction is needed.</span>
                      </div>
                    </section>
                  ) : (
                  <>
                  <section className="panel trick-panel">
                    <div className="panel-heading">
                      <h3>
                        01 <span>Select a Trick</span>
                      </h3>
                      <span className="muted">Type × diabolo count</span>
                    </div>
                    <div className="trick-grid">
                      <div className="grid-label" />
                      {["1D", "2D", "3D", "4D", "VD"].map((d) => (
                        <div className="column-label" key={d}>
                          {d}
                          <span>
                            {d === "VD"
                              ? "VERTICAL"
                              : `${d[0]} DIABOLO${d[0] === "1" ? "" : "S"}`}
                          </span>
                        </div>
                      ))}
                      {Object.entries(tricks).map(([type, dims]) => (
                        <div
                          className="trick-row"
                          data-category={type}
                          key={type}
                        >
                          <div className="row-label">{type}</div>
                          {["1D", "2D", "3D", "4D", "VD"].map((dim) => {
                            const id = `${type} ${dim}`;
                            return dims.includes(dim) ? (
                              <button
                                key={dim}
                                disabled={!canScore}
                                aria-pressed={trick === id}
                                className={`trick ${trick === id ? "selected" : ""}`}
                                onClick={() => setTrick(id)}
                              >
                                <span>
                                  {type} <b>{dim}</b>
                                </span>
                                {keysEnabled && <kbd>{hotkeys[id]}</kbd>}
                              </button>
                            ) : (
                              <div className="unavailable" key={dim}>
                                —
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </section>
                  <div className="modifiers">
                    <section className="panel">
                      <div className="panel-heading level-panel-heading">
                        <h3>
                          02 <span>Level</span>
                        </h3>
                        <div className="level-step-buttons">
                          <button type="button" disabled={!canScore || deductions.includes(trick) || level === technicalLevels[0]} aria-label="Decrease level" title="Level −" onClick={() => setLevel((current) => stepTechnicalLevel(current, -1))}>
                            Level − <kbd>{keysEnabled ? hotkeys["level:previous"] : ""}</kbd>
                          </button>
                          <button type="button" disabled={!canScore || deductions.includes(trick) || level === technicalLevels[technicalLevels.length - 1]} aria-label="Increase level" title="Level +" onClick={() => setLevel((current) => stepTechnicalLevel(current, 1))}>
                            Level + <kbd>{keysEnabled ? hotkeys["level:next"] : ""}</kbd>
                          </button>
                        </div>
                      </div>
                      <div className="level-buttons">
                        {technicalLevels.map((n) => (
                          <button
                            key={n}
                            disabled={!canScore || deductions.includes(trick)}
                            aria-pressed={level === n}
                            className={level === n ? "selected" : ""}
                            onClick={() => setLevel(n)}
                          >
                            L{n}
                          </button>
                        ))}
                      </div>
                    </section>
                    <section className="panel">
                      <div className="panel-heading">
                        <h3>
                          03 <span>Features</span>
                        </h3>
                        <span className="muted">Optional</span>
                      </div>
                      <div className="feature-buttons">
                        {["T1", "T2", "T3", "A"].map((f) => (
                          <button
                            key={f}
                            disabled={!canScore || deductions.includes(trick)}
                            aria-pressed={features.includes(f)}
                            className={features.includes(f) ? "selected" : ""}
                            onClick={() => toggleFeature(f)}
                          >
                            {f}
                          </button>
                        ))}
                      </div>
                    </section>
                    <section className="panel execution-panel">
                      <div className="panel-heading">
                        <h3>04 <span>Execution</span></h3>
                      </div>
                      <div className="execution-buttons">
                        {executionOptions.map((option) => (
                          <button
                            key={option}
                            type="button"
                            disabled={!canScore || deductions.includes(trick)}
                            aria-pressed={execution === option}
                            className={execution === option ? "selected" : ""}
                            onClick={() => setExecution(option)}
                          >
                            <span>{executionControlLabels[option]}</span>
                            <kbd>{keysEnabled ? hotkeys[`execution:${option}`] : ""}</kbd>
                          </button>
                        ))}
                      </div>
                    </section>
                  </div>
                  <section className="panel deductions">
                    <div className="panel-heading">
                      <h3>
                        <Flag size={15} /> Major Deductions
                      </h3>
                      <span className="muted">Recorded as events</span>
                    </div>
                    <div className="deduction-buttons">
                      {deductions.map((d) => (
                        <button
                          key={d}
                          disabled={!canScore}
                          aria-pressed={trick === d}
                          className={trick === d ? "selected" : ""}
                          onClick={() => setTrick(d)}
                        >
                          {d}
                          <kbd>{keysEnabled ? hotkeys[d] : ""}</kbd>
                        </button>
                      ))}
                    </div>
                  </section>
                  <div className="submit-bar">
                    <div>
                      <span className="eyebrow">
                        {editing ? "EDITING EVENT" : "CURRENT SELECTION"}
                      </span>
                      <b>
                        {trick || "Choose a trick or deduction"}
                        {trick && !deductions.includes(trick) && (
                          <small>
                            {" "}
                            / L{level}
                            {features.length
                              ? " / " + features.join(" + ")
                              : ""}
                            {" / " + executionControlLabels[execution]}
                          </small>
                        )}
                      </b>
                    </div>
                    <button className="clear-button" disabled={!canScore} onClick={clear}>
                      Clear <kbd>esc</kbd>
                    </button>
                    <button
                      className="primary"
                      disabled={!trick || !canScore}
                      onClick={submit}
                    >
                      <Plus size={18} />
                      {editing ? "Update Event" : "Record Event"}
                      <kbd>↵</kbd>
                    </button>
                  </div>
                  </>
                  )}
                  <div className="scoring-foot">
                    <span>
                      <CheckCircle2 size={14} />{" "}
                      {demo
                        ? "Score saved locally · demo"
                        : syncError && workspace.queue.length
                          ? "Sync failed · score saved locally"
                        : workspace.queue.length
                          ? `${workspace.queue.length} change(s) saved locally · awaiting sync`
                          : syncing
                            ? "Syncing score…"
                            : "Score synced"}
                    </span>
                    {!submissionSubmitted && (
                      <button
                        disabled={!canScore}
                        className="danger-quiet"
                        onClick={() =>
                          setModal({
                            title: displayed?.dq
                              ? "Remove disqualification?"
                              : "Disqualify this submission?",
                            body: "This is a consequential scoring decision and will be recorded in the audit trail.",
                            action: () =>
                              persistAction("dq", { dq: !displayed?.dq }),
                          })
                        }
                      >
                        <Flag size={13} />
                        {displayed?.dq ? "Undo disqualification" : "Disqualify"}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="performance-layout">
                <div className="panel category-panel">
                  {submissionSubmitted && (
                    <div className="submission-locked-state performance-locked-state" role="status" aria-live="polite">
                      <Lock size={18} />
                      <div>
                        <strong>Submitted — Waiting for the next competitor</strong>
                        <span>Your ratings are locked. An organizer can reopen them if a correction is needed.</span>
                      </div>
                    </div>
                  )}
                  {categories.map((category, i) => (
                    <div className="category" key={category}>
                      <div>
                        <span className="category-index">0{i + 1}</span>
                        <div>
                          <h3>{category}</h3>
                        </div>
                        <strong>
                          {canViewSubmissionPoints(displayed)
                            ? (displayed?.performance[i] ?? 0).toFixed(1)
                            : "***"}
                        </strong>
                      </div>
                      {!submissionSubmitted && (
                        <div className="rating-options">
                          {Array.from({ length: 11 }, (_, n) => n * 0.5).map(
                            (value) => (
                              <button
                                key={value}
                                disabled={!canScore}
                                className={
                                  (displayed?.performance[i] ?? 0) === value
                                    ? "selected"
                                    : ""
                                }
                                onClick={() => {
                                  persistAction("performance", {
                                    index: i,
                                    value,
                                  });
                                }}
                              >
                                {value}
                              </button>
                            ),
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <aside className="panel performance-summary">
                  <h2>Performance</h2>
                  <div className="big-total">
                    {canViewSubmissionPoints(displayed)
                      ? (displayed?.performance.reduce((a, b) => a + b, 0) ?? 0).toFixed(1)
                      : "***"}
                    <span>/ 30</span>
                  </div>
                  {categories.map((c, i) => (
                    <div className="summary-row" key={c}>
                      <span>{c}</span>
                      <b>{canViewSubmissionPoints(displayed) ? (displayed?.performance[i] ?? 0).toFixed(1) : "***"}</b>
                    </div>
                  ))}
                </aside>
              </div>
            )}
            <section className="up-next">
              <span className="eyebrow">UP NEXT</span>
              {state.competitors
                .filter((c) => c.status === "upcoming" && !c.archived)
                .sort((a, b) => a.position - b.position)
                .slice(0, 3)
                .map((c) => (
                  <div key={c.id}>
                    <span>{String(c.position).padStart(2, "0")}</span>
                    <b>
                      {c.name}
                      <small>{c.division}</small>
                    </b>
                    <Lock size={13} />
                  </div>
                ))}
              <button onClick={() => setTab("Saved Competitors")}>
                Full Performance Order <ArrowRight size={14} />
              </button>
            </section>
          </>
        )}
        {tab === "Saved Competitors" && (
          <section className="panel records">
            <div className="panel-heading">
              <h3>Performance Order</h3>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option>All Divisions</option>
                {allDivisions.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Competitor</th>
                    <th>Division</th>
                    <th>Routine</th>
                    <th>Your Submission</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {state.competitors
                    .filter(
                      (c) =>
                        !c.archived &&
                        (filter === "All divisions" || c.division === filter),
                    )
                    .sort((a, b) => a.position - b.position)
                    .map((c) => {
                      const s = state.submissions.find(
                        (s) =>
                          s.competitor_id === c.id && s.user_id === profile?.id,
                      );
                      return (
                        <tr key={c.id}>
                          <td className="mono">
                            {String(c.position).padStart(2, "0")}
                          </td>
                          <td>
                            <b>{c.name}</b>
                            {c.dq && <span className="pill danger">DQ</span>}
                          </td>
                          <td>{c.division}</td>
                          <td>
                            <span
                              className={`pill ${c.status === "active" ? "live" : ""}`}
                            >
                              {c.status}
                            </span>
                          </td>
                          <td>
                            {s?.finished
                              ? "Submitted"
                              : s
                                ? "In progress"
                                : "Not started"}
                          </td>
                          <td>
                            {server ? (
                              <div className="row-actions">
                                {(["Technical", "Performance"] as const).map(
                                  (view) => (
                                    <button
                                      key={view}
                                      onClick={() => {
                                        setSelected(c.id);
                                        setTab(view);
                                        clear();
                                      }}
                                    >
                                      {view}
                                    </button>
                                  ),
                                )}
                              </div>
                            ) : (
                              <button
                                disabled={
                                  !isAssignedJudge(profile!) ||
                                  (!s && c.status !== "active")
                                }
                                onClick={() => {
                                  setSelected(c.id);
                                  setTab(
                                    technical ? "Technical" : "Performance",
                                  );
                                  clear();
                                }}
                              >
                                {s ? "Open entry" : "Score"}
                                <ChevronRight size={14} />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {tab === "Rankings" && (
          <section className="panel records">
            <div className="panel-heading">
              <h3>
                <Trophy size={17} /> Your Personal Rankings
              </h3>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option>All Divisions</option>
                {allDivisions.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </div>
            {exports(exportPersonal)}
            <table>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Competitor</th>
                  <th>Division</th>
                  {!technical && <th>Your score</th>}
                </tr>
              </thead>
              <tbody>
                {(state.personal ?? [])
                  .filter(
                    (r) =>
                      filter === "All divisions" ||
                      state.competitors.find((c) => c.id === r.competitor_id)
                        ?.division === filter,
                  )
                  .map((r) => {
                    const c = state.competitors.find(
                      (c) => c.id === r.competitor_id,
                    )!;
                    return (
                      <tr key={r.competitor_id}>
                        <td>#{r.rank}</td>
                        <td>{c.name}</td>
                        <td>{c.division}</td>
                        {!technical && <td>{canViewPersonalPoints(r.competitor_id) ? fmt(r.total) : "***"}</td>}
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            {!state.personal?.length && (
              <div className="empty-state">
                <Trophy />
                <h3>No Submitted Rankings Yet</h3>
                <p>
                  Finish and sync a submission to see your personal results.
                </p>
              </div>
            )}
          </section>
        )}
        {tab === "Score Details" && (
          <section className="panel records">
            <div className="panel-heading">
              <h3>Submission Details</h3>
            </div>
            {canViewPoints && <div className="exports">
              {(["csv", "txt"] as const).map((format) => (
                <button
                  key={format}
                  onClick={() =>
                    download(
                      detailExportRows(
                        profile!,
                        [...visibleSubmissions].sort((a, b) =>
                          a.updated_at.localeCompare(b.updated_at),
                        ),
                        state.competitors,
                        canViewPoints,
                        state.profiles ?? [],
                      ),
                      format,
                      "score-details",
                    )
                  }
                >
                  <Download size={14} /> Export {format.toUpperCase()}
                </button>
              ))}
            </div>}
            {!canViewPoints && <p className="masked-points-note" role="status">Unlock Admin and turn on Show Points to export full score details.</p>}
            {visibleSubmissions.map((s) => (
              <details className="submission-detail" key={s.id}>
                <summary>
                  <span>
                    {
                      state.competitors.find((c) => c.id === s.competitor_id)
                        ?.name
                    }
                  </span>
                  <span>{s.scoring_type === "performance" ? "Performance" : s.scoring_type === "technical" ? "Technical" : "Unknown scoring type"} · {state.profiles?.find((judge) => judge.id === s.user_id)?.name ?? (s.user_id === profile?.id ? profile.name : s.judge_name_snapshot ?? "Deleted Judge")}</span>
                  <span>
                    {s.finished ? "Submitted" : "Draft"}
                    {s.dq ? " · DQ" : ""}
                    {canViewSubmissionPoints(s)
                      ? ` · Total ${s.total === undefined ? "***" : fmt(s.total)}`
                      : " · Total ***"}
                  </span>
                </summary>
                {server && (
                  <div className="row-actions">
                    {!s.finished && <button
                      disabled={demo}
                      onClick={() => setModal({
                        title: "Mark this submission submitted?",
                        body: "This change is recorded in the audit log.",
                        action: () => {
                          void api("review", { id: s.id, version: s.version, finished: true, dq: s.dq })
                            .then(refresh).catch((e) => setSyncError(e.message));
                        },
                      })}
                    >Mark submitted</button>}
                    {s.finished && <button
                      disabled={demo}
                      onClick={() => {
                        const competitor = state.competitors.find((row) => row.id === s.competitor_id);
                        const previous = state.competitors.find((row) => row.status === "active" && row.id !== s.competitor_id);
                        setModal({
                          title: `Reopen ${competitor?.name ?? "competitor"} for Everyone?`,
                          body: `${previous ? `${previous.name} will be locked. ` : ""}This changes the active scoring target for every judge assigned to ${competitor?.division ?? "this division"}. All their saved work stays intact; submitted judges can edit after the shared reopen.`,
                          action: () => void manage("activate", { id: s.competitor_id }),
                          confirmLabel: "Reopen for Everyone",
                          danger: true,
                        });
                      }}
                    >Reopen Competitor for Everyone</button>}
                    <button
                      disabled={demo}
                      onClick={() =>
                        setModal({
                          title: s.dq
                            ? "Remove DQ?"
                            : "Disqualify this submission?",
                          body: "This change is recorded in the audit log.",
                          action: () => {
                            void api("review", {
                              id: s.id,
                              version: s.version,
                              finished: s.finished,
                              dq: !s.dq,
                            })
                              .then(refresh)
                              .catch((e) => setSyncError(e.message));
                          },
                        })
                      }
                    >
                      {s.dq ? "Remove DQ" : "Disqualify"}
                    </button>
                  </div>
                )}
                <p>
                  {new Date(s.updated_at).toLocaleString()}
                  {s.submitted_at
                    ? ` · Submitted ${new Date(s.submitted_at).toLocaleString()}`
                    : ""}
                </p>
                {s.scoring_type === "technical"
                  ? s.events.map((e, i) => (
                      <SubmissionEventDetail key={e.id} event={e} index={i} revealPoints={canViewPoints} />
                    ))
                  : categories.map((c, i) => (
                      <div className="detail-event detail-event-category" key={c}>
                        <b className="detail-event-title">{c}</b>
                        <b className="detail-event-points">{canViewSubmissionPoints(s) ? (s.performance[i] ?? 0).toFixed(1) : "***"}</b>
                      </div>
                    ))}
              </details>
            ))}
            {!visibleSubmissions.length && (
              <div className="empty-state">No submissions yet.</div>
            )}
            {server && (
              <>
                <h3 className="audit-title">Audit History</h3>
                {!demo && canViewPoints && !!state.audit?.length && (
                  <button
                    style={{ margin: 20 }}
                    onClick={async () => {
                      try {
                        const older = await api(
                          `audit?before=${state.audit![state.audit!.length - 1].id}`,
                          undefined,
                          adminUnlockToken ? { adminUnlockToken, showPoints: true } : undefined,
                        );
                        if (!older.length) {
                          setNotice("No earlier audit records.");
                          return;
                        }
                        await commit({
                          ...workspace,
                          snapshot: {
                            ...state,
                            audit: [...state.audit!, ...older],
                          },
                        });
                      } catch (e) {
                        setSyncError((e as Error).message);
                      }
                    }}
                  >
                    Load earlier history
                  </button>
                )}
                {canViewPoints ? (
                  (state.audit ?? []).map((a, i) => (
                    <details className="audit" key={i}>
                      <summary>
                        {String(a.created_at)} · {String(a.action)} ·{" "}
                        {String(a.user_id)}
                      </summary>
                      <pre>
                        {JSON.stringify(
                          { prior: a.prior, next: a.next },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  ))
                ) : (
                  <p className="masked-points-note">Score details in audit history are hidden until Show points is enabled.</p>
                )}
              </>
            )}
          </section>
        )}
        {tab === "Admin" && (
          !adminUnlocked ? (
            <section className="panel admin-password-panel">
              <div className="panel-heading">
                <h3>Admin Access</h3>
              </div>
              <p>Enter the admin password to view score values.</p>
              <form onSubmit={verifyAdminPassword}>
                <label>
                  Admin password
                  <PasswordField
                    autoComplete="current-password"
                    required
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                  />
                </label>
                {adminPasswordError && (
                  <p className="error" role="alert">
                    {adminPasswordError}
                  </p>
                )}
                <button className="primary" disabled={adminPasswordBusy}>
                  {adminPasswordBusy ? "Checking…" : "Unlock Admin Tab"}
                  <ArrowRight size={16} />
                </button>
              </form>
            </section>
          ) : (
          <section className="panel records">
            <div className="panel-heading">
              <div>
                <h3>Admin Access</h3>
                <p className="muted admin-points-help">Unlock stays active as you move between tabs. It resets after reload.</p>
              </div>
              <button
                onClick={lockAdmin}
              >
                <Lock size={14} /> Lock Admin Tab
              </button>
            </div>
            <div className="admin-points-toggle-row">
              <div>
                <b>Show Points</b>
                <span className="muted">{showPoints ? "Your permitted score data is visible across this session." : "Point values and totals stay masked until enabled."}</span>
              </div>
              <button
                type="button"
                className={`admin-points-toggle ${showPoints ? "enabled" : ""}`}
                role="switch"
                aria-checked={showPoints}
                onClick={() => void toggleShowPoints()}
              >
                {showPoints ? "Hide Points" : "Show Points"}
              </button>
            </div>
            {canViewPoints && exports((format, ranked) => {
              const ordered = [...personalSubmissions].sort((a, b) =>
                ranked
                  ? (b.total ?? 0) - (a.total ?? 0)
                  : a.updated_at.localeCompare(b.updated_at),
              );
              download(
                personalScoreExportRows(profile!, ordered, state.competitors, canViewPoints),
                format,
                "my-scores",
              );
            })}
            {personalSubmissions.map((s) => (
              <details className="submission-detail" key={s.id}>
                <summary>
                  <span>
                    {
                      state.competitors.find((c) => c.id === s.competitor_id)
                        ?.name
                    }
                  </span>
                  <span>
                    {s.finished ? "Submitted" : "Draft"}
                    {s.dq ? " · DQ" : ""}
                  </span>
                  <span>Total {canViewSubmissionPoints(s) && s.total !== undefined ? fmt(s.total) : "***"}</span>
                </summary>
                {s.scoring_type === "technical"
                  ? s.events.map((e, i) => (
                      <SubmissionEventDetail key={e.id} event={e} index={i} revealPoints={canViewPoints} />
                    ))
                  : categories.map((c, i) => (
                      <div className="detail-event detail-event-category" key={c}>
                        <b className="detail-event-title">{c}</b>
                        <b className="detail-event-points">{canViewSubmissionPoints(s) ? (s.performance[i] ?? 0).toFixed(1) : "***"}</b>
                      </div>
                    ))}
              </details>
            ))}
            {!personalSubmissions.length && (
              <div className="empty-state">No scores yet.</div>
            )}
          </section>
          )
        )}
        {tab === "Server Access Control" && server && (
          <div className="organizer">
            <section className="panel">
              <div className="panel-heading">
                <h3>
                  <Radio size={17} /> Floor Control
                </h3>
                <span className="pill live">
                  {active ? "Routine active" : "Floor idle"}
                </span>
              </div>
              <div className="floor-control">
                <div>
                  <span className="eyebrow">CURRENT COMPETITOR</span>
                  <h2>{active?.name ?? "Ready for the next routine"}</h2>
                  <p>{active?.division ?? "Choose a competitor to begin."}</p>
                </div>
                <button
                  disabled={!active}
                  onClick={() =>
                    active &&
                    setModal({
                      title: "End and Lock This Routine?",
                      body: "Judges can still correct their existing saved submissions. New entries require the routine to be active.",
                      action: () => void manage("lock", { id: active.id }),
                    })
                  }
                >
                  <Lock size={15} /> End Routine
                </button>
                <button
                  className="primary"
                  disabled={
                    !nextUpcoming
                  }
                  onClick={() => {
                    const next = nextUpcoming;
                    if (next)
                      setModal({
                        title: `Activate ${next.name}?`,
                        body: "The current routine will be locked and all connected judges will see this competitor.",
                        action: () => void manage("activate", { id: next.id }),
                      });
                  }}
                >
                  Start Next <ArrowRight size={16} />
                </button>
              </div>
            </section>
            <section className="panel records division-assignment-panel">
              <div className="panel-heading">
                <h3>Division Judge Assignments</h3>
                <div className="division-assignment-header-actions">
                  {allDivisions.length ? <label>
                    Division
                    <select
                      aria-label="Division judge assignments"
                      value={assignmentDivision}
                      onChange={(event) => {
                        const nextDivision = event.target.value;
                        setAssignmentDivision(nextDivision);
                        setAssignmentDraft(null);
                      }}
                    >
                      {allDivisions.map((division) => <option key={division}>{division}</option>)}
                    </select>
                  </label> : <span className="muted">No divisions</span>}
                  <button
                    type="button"
                    disabled={demo}
                    onClick={() => {
                      setNewDivision("");
                      setDivisionFormOpen(true);
                    }}
                  >
                  <Plus size={14} /> Add Division
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={demo || !assignmentDivision}
                    onClick={() => {
                      setDivisionDeleteTarget(assignmentDivision);
                      setDivisionDeleteConfirmation("");
                    }}
                  >
                    <Trash2 size={14} /> Delete Division
                  </button>
                </div>
              </div>
              <p>Normally assign 3 Technical Judges and 2 Performance Judges. Each division has its own group; judges may serve in multiple divisions. Organizers count only when explicitly assigned.</p>
              {assignmentLocked ? <p className="info-note" role="status">This division’s official roster is locked because competitors already exist in it.</p> : null}
              {divisionFormOpen && (
                <form className="division-add-form" onSubmit={addDivision}>
                  <label>
                    New division name
                    <input
                      autoFocus
                      required
                      maxLength={80}
                      value={newDivision}
                      onChange={(event) => setNewDivision(event.target.value)}
                    />
                  </label>
                  {newDivision.trim() && allDivisions.some((division) => division.trim().toLocaleLowerCase() === newDivision.trim().toLocaleLowerCase()) ? (
                    <span className="division-duplicate-hint" role="status">This division already exists. Select it from the Division list.</span>
                  ) : null}
                  <button type="button" onClick={() => setDivisionFormOpen(false)}>Cancel</button>
                  <button className="primary" disabled={demo || !newDivision.trim() || allDivisions.some((division) => division.trim().toLocaleLowerCase() === newDivision.trim().toLocaleLowerCase())}>Save Division</button>
                </form>
              )}
              {assignmentDivision ? <div className="division-assignment-grid">
                {editableAssignmentRows.map(({ slot, user_id, scoring_type }) => {
                  const usedElsewhere = new Set(editableAssignmentRows.filter((row) => row.slot !== slot).map((row) => row.user_id));
                  const updateRow = (change: Partial<{ user_id: string; scoring_type: ScoringType }>) => {
                    setAssignmentDraft((prior) => ({ ...(prior ?? currentAssignmentDraft), [String(slot)]: { ...editableAssignments[String(slot)], ...change } }));
                  };
                  return (
                    <div className="assignment-judge-row" key={slot}>
                      <b>{scoring_type === "technical" ? "Technical Judge" : "Performance Judge"}</b>
                      <label>
                        Scoring group
                        <select disabled={assignmentLocked} value={scoring_type} onChange={(event) => {
                          const nextType = event.target.value as ScoringType;
                          const assignedProfile = divisionProfiles.find((candidate) => candidate.id === user_id);
                          updateRow({ scoring_type: nextType, user_id: assignedProfile && profileCanScoreType(assignedProfile, nextType) ? user_id : "" });
                        }}>
                          <option value="technical">Technical</option>
                          <option value="performance">Performance</option>
                        </select>
                      </label>
                      <label>
                        Judge account
                        <select disabled={assignmentLocked} value={user_id} onChange={(event) => updateRow({ user_id: event.target.value })}>
                          <option value="">Select assigned judge</option>
                          {divisionProfiles.filter((p) => profileCanScoreType(p, scoring_type)).map((p) => (
                            <option key={p.id} value={p.id} disabled={usedElsewhere.has(p.id)}>
                              {p.name} · @{p.username}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button type="button" disabled={assignmentLocked} aria-label="Remove assignment" title="Remove assignment" onClick={() => {
                        const remaining = editableAssignmentRows.filter((row) => row.slot !== slot);
                        setAssignmentDraft(Object.fromEntries(remaining.map((row, index) => [String(index + 1), { user_id: row.user_id, scoring_type: row.scoring_type }])));
                      }}><Trash2 size={14} /> Remove</button>
                    </div>
                  );
                })}
                <div className="assignment-editor-actions">
                  <button type="button" disabled={assignmentLocked || editableAssignmentRows.length >= 10} onClick={() => {
                    const nextSlot = editableAssignmentRows.length + 1;
                    const techCount = editableAssignmentRows.filter((row) => row.scoring_type === "technical").length;
                    const performanceCount = editableAssignmentRows.filter((row) => row.scoring_type === "performance").length;
                    const scoring_type = techCount === 0 ? "technical" : performanceCount === 0 ? "performance" : techCount <= performanceCount ? "technical" : "performance";
                    setAssignmentDraft((prior) => ({ ...(prior ?? currentAssignmentDraft), [String(nextSlot)]: { user_id: "", scoring_type } }));
                  }}><Plus size={14} /> Add Judge</button>
                  <button
                    className="primary"
                    disabled={
                      assignmentLocked || editableAssignmentRows.length < 2 || editableAssignmentRows.length > 10 ||
                      editableAssignmentRows.some((row) => !row.user_id) ||
                      new Set(editableAssignmentRows.map((row) => row.user_id)).size !== editableAssignmentRows.length ||
                      !editableAssignmentRows.some((row) => row.scoring_type === "technical") ||
                      !editableAssignmentRows.some((row) => row.scoring_type === "performance")
                    }
                    onClick={() => {
                      const assignments = editableAssignmentRows.map(({ slot, user_id, scoring_type }) => ({ slot, user_id, scoring_type }));
                      const unchanged = JSON.stringify(assignments) === JSON.stringify(divisionAssignments.map(({ slot, user_id, scoring_type }) => ({ slot, user_id, scoring_type: assignmentScoringType({ division: assignmentDivision, slot, user_id, scoring_type }, state?.profiles?.find((p) => p.id === user_id)) })));
                      if (unchanged) return;
                      const divisionCompetitors = new Set(state?.competitors.filter((competitor) => competitor.division === assignmentDivision).map((competitor) => competitor.id));
                      const scored = (state?.submissions ?? []).filter((submission) => divisionCompetitors.has(submission.competitor_id) && (submission.version > 0 || submission.finished || submission.dq || submission.events.length > 0 || submission.performance.some((value) => value !== 0)));
                      const saveAssignments = () => void manage("assignments", { division: assignmentDivision, assignments });
                      if (scored.length) {
                        const affectedCompetitors = new Set(scored.map((submission) => submission.competitor_id)).size;
                        setModal({
                          title: "Change Division Judge Assignments?",
                          body: `${scored.length} saved score submission${scored.length === 1 ? "" : "s"} across ${affectedCompetitors} competitor${affectedCompetitors === 1 ? "" : "s"} will be evaluated against the new assigned group. Historical scores remain attributed to their original judges, but completion and final rankings may change.`,
                          action: saveAssignments,
                          confirmLabel: "Confirm Assignment Change",
                          danger: true,
                        });
                      } else saveAssignments();
                    }}
                  >Save Judge Group</button>
                </div>
              </div> : <p className="division-empty-state">Add a division to configure its assigned judges.</p>}
            </section>
            <section className="panel records progress-overview">
              <div className="panel-heading">
                <h3>Competitor Progress</h3>
                <span className="muted">Green only when all assigned judges submit</span>
              </div>
              <div className="progress-table-wrap">
                <div className="progress-table-header" aria-hidden="true">
                  <span>Order</span><span>Competitor · Division</span><span>Overall</span><span>Assigned Judges</span>
                </div>
                <div className="progress-list">
                  {progressRows.map(({ competitor, entries, complete, stateLabel }) => {
                    const status = complete ? "progress-complete" : competitor.status === "active" ? "progress-active" : "progress-locked";
                    return (
                      <div className={`progress-row ${status}`} key={competitor.id}>
                        <span className="progress-order">{String(competitor.position).padStart(2, "0")}</span>
                        <div className="progress-competitor"><b>{competitor.name}</b><small>{competitor.division}</small></div>
                        <span className={`progress-status ${status}`}>
                          {complete ? "✓ Complete" : competitor.status === "active" ? "● Active · in progress" : stateLabel}
                        </span>
                        <div className="judge-progress-list">
                          {validProgressAssignments(entries) ? entries.map((entry) => (
                            <span
                              key={entry.user_id}
                              className={`judge-progress ${entry.status === "Submitted" ? "finished" : entry.status === "In progress" ? "draft" : "not-started"}`}
                              title={`${entry.scoring_type === "technical" ? "Technical" : "Performance"} · ${entry.name} · ${entry.status}`}
                            >
                              <b>{entry.scoring_type === "technical" ? "Technical" : "Performance"} · {entry.name}</b><em>{entry.status}</em>
                            </span>
                          )) : <span className="assignment-warning">Assign 2–10 judges across both scoring groups</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
            {canManageScoringConfig && adminUnlocked && showPoints && adminUnlockToken ? (
              <TechnicalPointConfiguration
                adminUnlockToken={adminUnlockToken}
                queuedActions={workspace?.queue.length ?? 0}
                oldestQueuedRevision={oldestQueuedConfigRevision}
                onSaved={() => {
                  if (workspace?.queue.length) {
                    setScoringReconciliationNotice("Pending offline score selections will be calculated with the updated rules when they sync.");
                  }
                  void refresh();
                }}
              />
            ) : null}
            <section className="panel records">
              <div className="panel-heading">
                <h3>Competitor Roster</h3>
                <button
                  className="primary"
                  disabled={!allDivisions.length}
                  onClick={() =>
                    setCompetitorEdit({
                      name: "",
                      division: allDivisions[0] ?? "",
                      position: state.competitors.length + 1,
                      status: "upcoming",
                      dq: false,
                      archived: false,
                    })
                  }
                >
                  <Plus size={16} /> Add Competitor
                </button>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Competitor</th>
                      <th>Division</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...state.competitors]
                      .sort((a, b) => a.position - b.position)
                      .map((c) => (
                        <tr key={c.id}>
                          <td>{c.position}</td>
                          <td>
                            <b>{c.name}</b>
                            {c.dq && <span className="pill danger">DQ</span>}
                          </td>
                          <td>{c.division}</td>
                          <td>{c.archived ? "Legacy inactive" : c.status}</td>
                          <td>
                            <div className="row-actions">
                              <button onClick={() => setCompetitorEdit(c)}>
                                <Pencil size={13} /> Edit
                              </button>
                              <button
                                className="danger-button"
                                title="Delete competitor and saved scoring data"
                                onClick={() => setModal({
                                  title: `Delete ${c.name}?`,
                                  body: (() => {
                                    const submissionCount = state.submissions.filter((submission) => submission.competitor_id === c.id).length;
                                    const submissionImpact = submissionCount
                                      ? ` This will also permanently delete ${submissionCount} saved judge submission${submissionCount === 1 ? "" : "s"} and their scores.`
                                      : " This competitor has no saved judge submissions.";
                                    const activeImpact = c.status === "active" ? " The active routine will end." : "";
                                    return `This permanently deletes ${c.name} from the roster.${submissionImpact}${activeImpact} Any unsynced offline work for this competitor will not sync afterward. Existing audit history is retained. This cannot be undone.`;
                                  })(),
                                  action: () => void manage("delete", { id: c.id }),
                                  confirmLabel: "Delete Competitor",
                                  danger: true,
                                })}
                              >
                                <Trash2 size={13} /> Delete
                              </button>
                              <button
                                disabled={
                                  c.archived || c.status === "active" ||
                                  (c.status === "upcoming" && c.id !== nextUpcoming?.id) ||
                                  (c.status === "locked" && !state.submissions.some((s) => s.competitor_id === c.id))
                                }
                                onClick={() =>
                                  (() => {
                                    const previous = state.competitors.find((row) => row.status === "active" && row.id !== c.id);
                                    const reopening = c.status === "locked";
                                    setModal({
                                      title: reopening ? `Reopen ${c.name} for Everyone?` : `Activate ${c.name}?`,
                                      body: `${previous ? `${previous.name} will be locked. ` : ""}This switches the shared active competitor for every judge assigned to ${c.division}. ${reopening ? "Submitted scores will unlock for those judges; their saved work stays intact." : ""}`,
                                      action: () => void manage("activate", { id: c.id }),
                                      confirmLabel: reopening ? "Reopen for Everyone" : "Activate Competitor",
                                      danger: reopening,
                                    });
                                  })()
                                }
                              >
                                {c.status === "locked" ? "Reopen for Everyone" : "Activate"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="panel records">
              <div className="panel-heading">
                <h3>
                  <Users size={16} /> Judge Accounts
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    setAccountFormError("");
                    setUserEdit(createAccountForm());
                  }}
                >
                  <Plus size={15} /> Create Judge / Add User
                </button>
              </div>
              {demo && (
                <div className="info-note">
                  Demo accounts are previews. Connect Supabase to create and
                  manage real accounts.
                </div>
              )}
              <div className="account-cards">
                {(state.profiles ?? []).map((p) => {
                  const protectedAccount = ["alexandertai", "organizer"].includes(p.username?.toLowerCase() ?? "");
                  return (
                    <article className={`account-card ${p.archived ? "archived" : ""}`} key={p.id}>
                      <div className="account-card-identity">
                        <div className="avatar">
                          {p.avatar_url ? <img src={p.avatar_url} alt={`${p.name} profile`} /> : p.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("")}
                        </div>
                        <div><h3>{p.name}</h3><span>@{p.username}</span></div>
                      </div>
                      <div className="account-card-meta">
                        <span>{profileRoleLabel(p, profileScoringType(p))}</span>
                        <span className={p.archived ? "archived-label" : p.active ? "active-label" : "inactive-label"}>{p.archived ? "Archived · former judge" : p.active ? "Active" : "Inactive"}</span>
                        {protectedAccount ? <span>{p.username?.toLowerCase() === "alexandertai" ? "Protected full-access account" : "Protected Organizer account"}</span> : null}
                      </div>
                      <div className="account-card-actions">
                      {!protectedAccount ? <button type="button" onClick={() => { setAccountFormError(""); setUserEdit(editAccountForm(p)); }}>Manage Account</button> : null}
                        {p.archived ? (
                          <button type="button" disabled={demo} onClick={() => void manage("reactivate_user", { id: p.id })}>Reactivate</button>
                        ) : null}
                        {!protectedAccount && !p.archived ? (
                          <button type="button" className="danger-button" onClick={() => { setAccountDeleteTarget(p); setAccountDeleteConfirmation(""); }}>Delete Account</button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
            <section className="panel records">
              <div className="panel-heading">
                <h3>
                  <Trophy size={17} /> Global Rankings
                </h3>
                <span className="muted">70 technical + 30 performance</span>
              </div>
              {canViewPoints && exports((format, ranked) => {
                const rows = [...(state.rankings ?? [])]
                  .sort((a, b) =>
                    ranked
                      ? a.competitor.division.localeCompare(
                          b.competitor.division,
                        ) || (a.rank ?? 999) - (b.rank ?? 999)
                      : (
                          state.submissions
                            .filter(
                              (s) =>
                                s.competitor_id === a.competitor.id &&
                                s.submitted_at,
                            )
                            .map((s) => s.submitted_at!)
                            .sort()[0] ?? "9999"
                        ).localeCompare(
                          state.submissions
                            .filter(
                              (s) =>
                                s.competitor_id === b.competitor.id &&
                                s.submitted_at,
                            )
                            .map((s) => s.submitted_at!)
                            .sort()[0] ?? "9999",
                        ),
                  )
                  .map((r) => {
                    const technicalJudges = (r.judges ?? []).filter((judge) => judge.scoring_type === "technical");
                    const performanceJudges = (r.judges ?? []).filter((judge) => judge.scoring_type === "performance");
                    return {
                      Rank: r.rank,
                      Competitor: r.competitor.name,
                      Division: r.competitor.division,
                      Order: r.competitor.position,
                      ...Object.fromEntries(technicalJudges.map((judge, index) => [`Technical · ${judge.display_name}`, r.technical[index]])),
                      ...Object.fromEntries(performanceJudges.map((judge, index) => [`Performance · ${judge.display_name}`, r.performance[index]])),
                      Raw: r.raw,
                      Scaled: r.scaled,
                      Performance: r.average,
                      Final: r.final,
                      Complete: r.complete,
                      DQ: r.dq,
                    };
                  });
                download(
                  rows,
                  format,
                  ranked ? "global-ranked" : "global-order",
                );
              })}
              {!canViewPoints && (
                <p className="masked-points-note" role="status">Unlock Admin and turn on Show points to view global score details.</p>
              )}
              {allDivisions
                .filter((d) => d !== "Exhibition")
                .map((d) => {
                  const divisionCompetitors = state.competitors.filter((competitor) => competitor.division === d);
                  const competitorIds = new Set(divisionCompetitors.map((competitor) => competitor.id));
                  const judgeColumns = new Map<string, { user_id: string; scoring_type: ScoringType; roster_order: number; display_name: string }>();
                  for (const judge of state.judgeRoster ?? []) {
                    if (competitorIds.has(judge.competitor_id) && judge.expected) {
                      const key = `${judge.scoring_type}:${judge.user_id}`;
                      if (!judgeColumns.has(key)) judgeColumns.set(key, {
                        user_id: judge.user_id, scoring_type: judge.scoring_type,
                        roster_order: judge.roster_order,
                        display_name: state.profiles?.find((candidate) => candidate.id === judge.user_id)?.name ?? judge.display_name,
                      });
                    }
                  }
                  const columns = [...judgeColumns.values()].sort((a, b) =>
                    a.scoring_type === b.scoring_type
                      ? a.roster_order - b.roster_order
                      : a.scoring_type === "technical" ? -1 : 1,
                  );
                  const divisionRankings = (state.rankings ?? []).filter((ranking) => ranking.competitor.division === d);
                  const scoreColumnCount = columns.length + 4;
                  return (
                  <div key={d}>
                    <h3 className="division-title">{d}</h3>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            {[
                              "Rank",
                              "Competitor",
                              ...columns.map((judge) => `${judge.scoring_type === "technical" ? "T" : "P"} · ${judge.display_name}`),
                              "Raw tech",
                              "Scaled /70",
                              "Avg /30",
                              "Final /100",
                              "State",
                            ].map((h) => (
                              <th key={h}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {canViewPoints
                            ? divisionRankings.map((r) => {
                              const technicalValues = new Map((r.judges ?? []).filter((judge) => judge.scoring_type === "technical").map((judge, index) => [judge.user_id, r.technical[index]]));
                              const performanceValues = new Map((r.judges ?? []).filter((judge) => judge.scoring_type === "performance").map((judge, index) => [judge.user_id, r.performance[index]]));
                              return (
                              <tr key={r.competitor.id}>
                                <td>{r.rank ?? "—"}</td>
                                <td>{r.competitor.name}</td>
                                {[
                                  ...columns.map((judge) => judge.scoring_type === "technical" ? technicalValues.get(judge.user_id) ?? null : performanceValues.get(judge.user_id) ?? null),
                                  r.raw,
                                  r.scaled,
                                  r.average,
                                  r.final,
                                ].map((v, i) => (
                                  <td key={i}>{fmt(v)}</td>
                                ))}
                                <td>
                                  {r.dq
                                    ? "DQ"
                                    : r.complete
                                      ? "Complete"
                                      : "Pending"}
                                </td>
                              </tr>
                              );
                            })
                            : state.competitors
                                .filter((competitor) => competitor.division === d)
                                .sort((a, b) => a.position - b.position)
                                .map((competitor) => (
                                  <tr key={competitor.id}>
                                    <td>***</td>
                                    <td>{competitor.name}</td>
                                    {Array.from({ length: scoreColumnCount }, (_, index) => <td key={index}>***</td>)}
                                    <td>—</td>
                                  </tr>
                                ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );})}
            </section>
            <section className="panel records admin-tab-password-panel">
              <div className="panel-heading">
                <h3><Shield size={17} /> Shared Admin Tab Password</h3>
                <span className="pill">Administrators only</span>
              </div>
              <form className="admin-tab-password-form" onSubmit={changeAdminTabPassword}>
                <label>
                  New shared password
                  <PasswordField autoComplete="new-password" minLength={6} maxLength={256} required value={newAdminTabPassword} onChange={(e) => setNewAdminTabPassword(e.target.value)} />
                </label>
                <label>
                  Confirm new password
                  <PasswordField autoComplete="new-password" minLength={6} maxLength={256} required value={confirmAdminTabPassword} onChange={(e) => setConfirmAdminTabPassword(e.target.value)} />
                </label>
                {adminTabPasswordMessage && <p className="admin-tab-password-message muted" role="status">{adminTabPasswordMessage}</p>}
                <button className="primary">Update Shared Password <ArrowRight size={16} /></button>
              </form>
            </section>
          </div>
        )}
      </main>
      <footer>
        <span>
          NATIONAL DIABOLO LEAGUE <span> / </span> HIDC 2026
        </span>
        <span>
          <Shield size={12} />{" "}
          {demo ? "Isolated demo workspace" : "Secure scoring workspace"}{" "}
          <span>·</span> {online ? "Online" : "Offline"}
        </span>
      </footer>
      {settingsOpen && profile && (
        <Dialog title="Profile & Settings" close={() => setSettingsOpen(false)}>
          <div className="settings-accordion">
            <section className={`settings-section ${settingsSection === "account" ? "expanded" : ""}`}>
              <button type="button" className="settings-section-trigger" aria-expanded={settingsSection === "account"} aria-controls="settings-account" onClick={() => setSettingsSection((current) => current === "account" ? null : "account")}>
                <span>Account</span><ChevronRight size={16} aria-hidden="true" />
              </button>
              <div className="settings-section-content" id="settings-account" hidden={settingsSection !== "account"}>
                <div className="profile-avatar-control">
                  <span className="avatar profile-avatar-large">
                    {profile.avatar_url ? <img src={profile.avatar_url} alt={`${profile.name} profile`} /> : profile.name.trim().split(/\s+/).slice(0, 2).map((n) => n[0]?.toUpperCase()).join("")}
                  </span>
                  <div><b>Profile picture</b><p>JPEG, PNG, or WebP · up to 2 MB</p></div>
                  <label className="button-like">
                    <Camera size={15} /> Replace
                    <input type="file" accept="image/jpeg,image/png,image/webp" disabled={profileBusy || !online || demo} onChange={(e) => {
                      const file = e.currentTarget.files?.[0];
                      e.currentTarget.value = "";
                      if (file) void changeAvatar(file);
                    }} />
                  </label>
                  {profile.avatar_url && <button type="button" disabled={profileBusy || !online || demo} onClick={() => void removeAvatar()}><Trash2 size={15} /> Remove</button>}
                </div>
                {demo && <p className="info-note">Demo mode: account changes and profile pictures are not saved to a live account.</p>}
                <form className="profile-settings-form" onSubmit={saveProfileSettings}>
                  <label>Display name<input required maxLength={100} value={profileName} onChange={(e) => setProfileName(e.target.value)} /></label>
                  <label>Username<input required minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,31}" autoComplete="username" value={profileUsername} onChange={(e) => setProfileUsername(e.target.value)} /></label>
                  <p className="profile-help">Your username is used to sign in. It must be unique.</p>
                  <label>Current password <span className="muted">(required for username or password changes)</span><PasswordField autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></label>
                  <label>New password <span className="muted">(optional · minimum 6 characters)</span><PasswordField minLength={6} maxLength={256} autoComplete="new-password" value={newLoginPassword} onChange={(e) => setNewLoginPassword(e.target.value)} /></label>
                  <label>Confirm new password<PasswordField minLength={6} maxLength={256} autoComplete="new-password" value={confirmLoginPassword} onChange={(e) => setConfirmLoginPassword(e.target.value)} /></label>
                  <p className="password-privacy-notice">Use a password only for this scoring system. Event organizers can reset account access; do not reuse a personal password.</p>
                  <div className="profile-settings-actions"><button className="primary" disabled={profileBusy || (!online && !demo)}>{profileBusy ? "Saving…" : "Save Profile"}</button></div>
                </form>
              </div>
            </section>

            <section className={`settings-section ${settingsSection === "appearance" ? "expanded" : ""}`}>
              <button type="button" className="settings-section-trigger" aria-expanded={settingsSection === "appearance"} aria-controls="settings-appearance" onClick={() => setSettingsSection((current) => current === "appearance" ? null : "appearance")}>
                <span>Appearance</span><ChevronRight size={16} aria-hidden="true" />
              </button>
              <div className="settings-section-content" id="settings-appearance" hidden={settingsSection !== "appearance"}>
                <AppearanceSettings initial={normalizeAppearancePreferences(profile.appearance_preferences)} online={online && !demo} demo={demo} onPreview={previewAppearance} onSave={saveAppearancePreferences} />
                {appearanceSyncError && <p className="error appearance-sync-error" role="status">{appearanceSyncError}</p>}
              </div>
            </section>

            <section className={`settings-section ${settingsSection === "hotkeys" ? "expanded" : ""}`}>
              <button type="button" className="settings-section-trigger" aria-expanded={settingsSection === "hotkeys"} aria-controls="settings-hotkeys" onClick={() => setSettingsSection((current) => current === "hotkeys" ? null : "hotkeys")}>
                <span>Hotkeys</span><ChevronRight size={16} aria-hidden="true" />
              </button>
              <div className="settings-section-content" id="settings-hotkeys" hidden={settingsSection !== "hotkeys"}>
                <p className="settings-section-help">Shortcuts are pressed in sequence within 0.9 seconds and pause while typing in a field.</p>
                <label className="checkbox"><input type="checkbox" checked={keysEnabled} onChange={(event) => {
                  setKeysEnabled(event.target.checked);
                }} /> Enable keyboard shortcuts</label>
                <div className="hotkey-list">
                  {Object.entries(hotkeys).map(([action, key]) => <label key={action}>
                    <span>{hotkeyActionLabel(action)}</span>
                    <input aria-label={`Hotkey for ${action}`} value={key} onChange={(event) => setHotkeys({ ...hotkeys, [action]: event.target.value })} />
                  </label>)}
                </div>
                <div className="settings-section-actions">
                  <button type="button" onClick={() => setHotkeys(defaultKeys)}>Reset Defaults</button>
                  <button type="button" className="primary" onClick={() => void saveHotkeyPreferences()}>Save Hotkeys</button>
                </div>
              </div>
            </section>

            <section className={`settings-section ${settingsSection === "privacy" ? "expanded" : ""}`}>
              <button type="button" className="settings-section-trigger" aria-expanded={settingsSection === "privacy"} aria-controls="settings-privacy" onClick={() => setSettingsSection((current) => current === "privacy" ? null : "privacy")}>
                <span>Privacy / Local Data</span><ChevronRight size={16} aria-hidden="true" />
              </button>
              <div className="settings-section-content" id="settings-privacy" hidden={settingsSection !== "privacy"}>
                <div className="profile-setting-row"><div><b>Offline cache</b><span>Clears only this account’s saved workspace on this browser.</span></div>
                  <button type="button" disabled={!!workspace?.queue.length} onClick={() => {
                    setSettingsOpen(false);
                    setModal({
                      title: "Clear Your Offline Cache?",
                      body: workspace?.queue.length ? "Sync pending score changes first." : "This removes only your local workspace from this browser and signs you out. It does not delete online profiles or scoring records.",
                      action: () => void clearOwnOfflineCache(),
                    });
                  }}>Clear Cache</button>
                </div>
                {workspace?.queue.length ? <p className="profile-help">Sync {workspace.queue.length} pending score change(s) before clearing your cache or signing out.</p> : null}
                {!online && !demo && <p className="profile-help">Appearance and hotkey updates are saved locally while offline and sync when the server connection returns.</p>}
              </div>
            </section>

            <section className={`settings-section ${settingsSection === "session" ? "expanded" : ""}`}>
              <button type="button" className="settings-section-trigger" aria-expanded={settingsSection === "session"} aria-controls="settings-session" onClick={() => setSettingsSection((current) => current === "session" ? null : "session")}>
                <span>Session</span><ChevronRight size={16} aria-hidden="true" />
              </button>
              <div className="settings-section-content settings-session-content" id="settings-session" hidden={settingsSection !== "session"}>
                <span>Sign out of this judging account on this laptop.</span>
                <button type="button" onClick={() => void signOut()}><LogOut size={15} /> Sign Out</button>
              </div>
            </section>
          </div>
          {profileMessage && <p className={profileMessageError ? "error" : "success"} role="status">{profileMessage}</p>}
          {!online && !demo && <p className="profile-help">Profile, username, password, and picture changes require an online connection.</p>}
        </Dialog>
      )}
      {notice && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {notice}
        </div>
      )}
      {modal && (
        <Dialog title={modal.title} close={() => setModal(null)}>
          <p className={modal.danger ? "danger-warning" : undefined} role={modal.danger ? "alert" : undefined}>{modal.body}</p>
          <div className="dialog-actions">
            <button onClick={() => setModal(null)}>Cancel</button>
            <button
              className={modal.danger ? "danger-button" : "primary"}
              onClick={() => {
                modal.action();
                setModal(null);
              }}
            >
              {modal.confirmLabel ?? "Confirm"}
            </button>
          </div>
        </Dialog>
      )}
      {accountDeleteTarget && (
        <Dialog title="Confirm Delete Account" close={() => { setAccountDeleteTarget(null); setAccountDeleteConfirmation(""); }}>
          {(() => {
            const target = accountDeleteTarget;
            const hasHistory = accountHasScoreHistory(target.id);
            const confirmed = accountDeleteConfirmation === target.username || accountDeleteConfirmation === "DELETE JUDGE";
            return <>
              <p className="danger-warning">Account: <b>{target.username}</b><br />Role: <b>{profileRoleLabel(target, profileScoringType(target))}</b></p>
              <p className="account-delete-impact" role="alert">
                {hasHistory
                  ? "This permanently removes the judge’s login and profile. Existing submitted scores will be preserved for event records and visible only to authorized organizers. Unsubmitted work will not count toward future completion."
                  : "No score history was found. Delete will permanently remove the account profile and sign-in, plus any empty assignment placeholders. This cannot be undone."}
              </p>
              <label>
                Type <b>{target.username}</b> or <b>DELETE JUDGE</b> to confirm
                <input value={accountDeleteConfirmation} onChange={(event) => setAccountDeleteConfirmation(event.target.value)} autoComplete="off" />
              </label>
              <div className="dialog-actions">
                <button type="button" onClick={() => { setAccountDeleteTarget(null); setAccountDeleteConfirmation(""); }}>Cancel</button>
                <button type="button" className="danger-button" disabled={!confirmed || demo} onClick={() => void manage("remove_user", { id: target.id, confirmation: accountDeleteConfirmation })}>Permanently Delete Account</button>
              </div>
            </>;
          })()}
        </Dialog>
      )}
      {divisionDeleteTarget && (
        <Dialog title="Permanently Delete Division?" close={() => { setDivisionDeleteTarget(""); setDivisionDeleteConfirmation(""); }}>
          {(() => {
            const name = divisionDeleteTarget;
            const competitorIds = new Set((state?.competitors ?? []).filter((competitor) => competitor.division === name).map((competitor) => competitor.id));
            const competitorCount = competitorIds.size;
            const divisionSubmissions = (state?.submissions ?? []).filter((submission) => competitorIds.has(submission.competitor_id));
            const submittedCount = divisionSubmissions.filter((submission) => submission.finished).length;
            const pendingOfflineCount = (workspace?.queue ?? []).filter((operation) => competitorIds.has(operation.competitor_id)).length;
            const hasActive = (state?.competitors ?? []).some((competitor) => competitorIds.has(competitor.id) && competitor.status === "active");
            const confirmed = divisionDeleteConfirmation === name || divisionDeleteConfirmation === "DELETE DIVISION";
            return <>
              <p className="danger-warning">Division: <b>{name}</b></p>
              <dl className="division-delete-impact" aria-label="Deletion impact">
                <div><dt>Competitors</dt><dd>{competitorCount}</dd></div>
                <div><dt>Submitted scores</dt><dd>{submittedCount}</dd></div>
                {pendingOfflineCount ? <div><dt>Pending actions on this device</dt><dd>{pendingOfflineCount}</dd></div> : null}
              </dl>
              <p className="account-delete-impact" role="alert">
                This permanently deletes the division, its competitors, assignments, submissions, technical events, deductions, scoring-window records, and ranking inputs. Judge accounts and other divisions will not be changed.{hasActive ? " The active competitor will be cleared." : ""}{pendingOfflineCount ? " Pending offline actions for this division will no longer sync." : " Judges with unsynced offline work for this division will not be able to sync it after deletion."} This cannot be undone.
              </p>
              <label>
                Type <b>{name}</b> or <b>DELETE DIVISION</b> to confirm
                <input value={divisionDeleteConfirmation} onChange={(event) => setDivisionDeleteConfirmation(event.target.value)} autoComplete="off" />
              </label>
              <div className="dialog-actions">
                <button type="button" onClick={() => { setDivisionDeleteTarget(""); setDivisionDeleteConfirmation(""); }}>Cancel</button>
                <button type="button" className="danger-button" disabled={!confirmed || demo} onClick={() => void manage("remove_division", { name, confirmation: divisionDeleteConfirmation })}>Permanently Delete Division</button>
              </div>
            </>;
          })()}
        </Dialog>
      )}
      {competitorEdit && (
        <Dialog
          title={competitorEdit.id ? "Edit Competitor" : "Add Competitor"}
          close={() => setCompetitorEdit(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (competitorEdit.dq) {
                setModal({
                  title: "Confirm Disqualification?",
                  body: "Disqualifying this competitor changes access and results. Scores and audit history are preserved.",
                  action: () => void manage("save", competitorEdit),
                });
              } else void manage("save", competitorEdit);
            }}
          >
            <label>
              Competitor name
              <input
                required
                value={competitorEdit.name}
                onChange={(e) =>
                  setCompetitorEdit({ ...competitorEdit, name: e.target.value })
                }
              />
            </label>
            <label>
              Division
              <select
                required
                value={competitorEdit.division}
                onChange={(e) =>
                  setCompetitorEdit({
                    ...competitorEdit,
                    division: e.target.value,
                  })
                }
              >
                {allDivisions.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </label>
            {!competitorEdit.id && !competitorDraftRosterValid && (
              <p className="info-note" role="status">
                Save a division roster of 2–10 judges, including at least one Technical Judge and one Performance Judge, before adding a competitor.
              </p>
            )}
            <label>
              Performance order
              <input
                type="number"
                min="1"
                required
                value={competitorEdit.position}
                onChange={(e) =>
                  setCompetitorEdit({
                    ...competitorEdit,
                    position: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              Status
              <select
                value={competitorEdit.status}
                onChange={(e) =>
                  setCompetitorEdit({
                    ...competitorEdit,
                    status: e.target.value as Competitor["status"],
                  })
                }
              >
                <option value="upcoming">
                  Upcoming / unlocked for activation
                </option>
                <option value="locked">Locked</option>
                {competitorEdit.status === "active" && (
                  <option value="active">Active</option>
                )}
              </select>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={competitorEdit.dq}
                onChange={(e) =>
                  setCompetitorEdit({ ...competitorEdit, dq: e.target.checked })
                }
              />{" "}
              Disqualified
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={() => setCompetitorEdit(null)}>
                Cancel
              </button>
              <button className="primary" disabled={!competitorEdit.id && !competitorDraftRosterValid}>Save Competitor</button>
            </div>
          </form>
        </Dialog>
      )}
      {userEdit && (
        <Dialog
          title={userEdit.mode === "edit" ? "Manage Account" : "Create Account"}
          close={() => { setUserEdit(null); setAccountFormError(""); }}
        >
          <form
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              setAccountFormError("");
              const saveAccount = () => void manage(
                userEdit.mode === "create" ? "create_user" : "update_user",
                userEdit.mode === "create"
                  ? { name: userEdit.name, username: userEdit.username, role: userEdit.role, password: userEdit.password }
                  : { id: userEdit.id, name: userEdit.name, username: userEdit.username, role: userEdit.role, password: userEdit.password || undefined },
              );
              const removedAssignments = userEdit.mode === "edit"
                ? (state?.assignments ?? []).filter((assignment) => assignment.user_id === userEdit.id && !profileCanScoreType({ id: userEdit.id, name: userEdit.name, username: userEdit.username, role: userEdit.role, active: true }, assignmentScoringType(assignment)))
                : [];
              if (removedAssignments.length) {
                setModal({
                  title: "Change Account Role?",
                  body: `Changing this role will remove ${removedAssignments.length} incompatible division assignment${removedAssignments.length === 1 ? "" : "s"}. Existing scoring and audit history will remain attributed to this account.`,
                  action: saveAccount,
                  confirmLabel: "Confirm Role Change",
                  danger: true,
                });
              } else saveAccount();
            }}
          >
            <label>
              Display name
              <input type="text" required maxLength={100} value={userEdit.name ?? ""} onChange={(event) => setUserEdit({ ...userEdit, name: event.target.value })} />
            </label>
            <label>
              Username
              <input
                type="text"
                required
                autoComplete="off"
                readOnly={userEdit.mode === "edit" && userEdit.username.toLowerCase() === "alexandertai"}
                value={userEdit.username}
                onChange={(e) =>
                  setUserEdit({ ...userEdit, username: e.target.value })
                }
              />
            </label>
            <label>
              Role
              <select
                value={userEdit.role === "performance_judge" ? "performance_judge" : userEdit.role === "organizer" || userEdit.role === "server_admin" ? "organizer" : "technical_judge"}
                disabled={userEdit.mode === "edit" && userEdit.username.toLowerCase() === "alexandertai"}
                onChange={(event) => setUserEdit({ ...userEdit, role: event.target.value as Profile["role"] })}
              >
                <option value="technical_judge">Technical Judge</option>
                <option value="performance_judge">Performance Judge</option>
                <option value="organizer">Organizer</option>
              </select>
            </label>
            <label>
              {userEdit.mode === "edit"
                ? "New password (leave blank to keep)"
                : "Password (6+ characters)"}
              <PasswordField
                minLength={6}
                required={userEdit.mode === "create"}
                autoComplete="new-password"
                value={userEdit.password}
                onChange={(e) =>
                  setUserEdit({ ...userEdit, password: e.target.value })
                }
              />
            </label>
            {accountFormError && <p className="error" role="alert">{accountFormError}</p>}
            <p>Division assignments are managed separately. Organizers are scoring judges only when explicitly assigned.</p>
            <div className="dialog-actions">
              <button type="button" onClick={() => { setUserEdit(null); setAccountFormError(""); }}>
                Cancel
              </button>
              <button className="primary">{userEdit.mode === "create" ? "Create Account" : "Save Account"}</button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
function Dialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    const previous = document.activeElement as HTMLElement;
    return () => previous?.focus();
  }, []);
  return (
    <dialog ref={dialog} className="dialog" onCancel={close}>
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button className="icon" onClick={close} aria-label="Close dialog">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
