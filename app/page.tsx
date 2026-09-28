"use client";
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
  canEditJudge,
  isAssignedJudge,
  isAdministrator,
  canManageScoringConfiguration,
} from "@/lib/access";
import { api, demo, supabase } from "@/lib/supabase";
import { PasswordField } from "@/app/components/password-field";
import { profilePasswordError } from "@/lib/password-validation";
import { applyLocal, clearLocal, LocalWorkspace, readLocal, sanitizeWorkspace, writeLocal } from "@/lib/local";
import {
  categories,
  Competitor,
  deductions,
  demoCompetitors,
  divisions,
  Event,
  Operation,
  Profile,
  Snapshot,
  tricks,
} from "@/lib/model";
import { download } from "@/lib/export";
import TechnicalPointConfiguration from "@/app/components/technical-point-configuration";
import AppearanceSettings, { type AppearanceSaveResult } from "@/app/components/appearance-settings";
import { applyAppearance, AppearancePreferences, defaultAppearance, isAppearancePreferences } from "@/lib/appearance";
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
    [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [
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
const blankDemo = (slot = 1, role: Profile["role"] = "judge"): Snapshot => {
  const sampleJudges = [1, 2, 3, 4, 5].map((judgeSlot): Profile => ({
    id: `demo-user-${judgeSlot}`,
    name: `Demo Judge ${judgeSlot}`,
    username: `demo-judge-${judgeSlot}`,
    role: "judge",
    slot: judgeSlot,
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
      id: `demo-sub-${finishedSample.id}-${judge.slot}`,
      competitor_id: finishedSample.id,
      user_id: judge.id,
      slot: judge.slot!,
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
      id: `demo-user-${role === "server_admin" ? "organizer" : slot}`,
      name: role === "server_admin" ? "Event organizer" : `Demo Judge ${slot}`,
      role,
      slot: role === "judge" ? slot : null,
      active: true,
    },
    competitors: demoRoster,
    submissions: sampleSubmissions,
    protected: role === "server_admin",
    profiles: sampleJudges,
    assignments: allDemoDivisions.map((division) =>
      sampleJudges.map((judge) => ({ division, slot: judge.slot!, user_id: judge.id })),
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
    [syncError, setSyncError] = useState(""),
    [scoringReconciliationNotice, setScoringReconciliationNotice] = useState(""),
    [notice, setNotice] = useState(""),
    [tab, setTab] = useState("Technical"),
    [technicalViewSlot, setTechnicalViewSlot] = useState(1),
    [performanceViewSlot, setPerformanceViewSlot] = useState(4),
    [selected, setSelected] = useState<string | null>(null),
    [theme, setTheme] = useState("light");
  const [appearance, setAppearance] = useState<AppearancePreferences>(defaultAppearance);
  const [themePreference, setThemePreference] = useState<"system" | "light" | "dark">("light");
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const [trick, setTrick] = useState(""),
    [level, setLevel] = useState(1),
    [features, setFeatures] = useState<string[]>([]),
    [editing, setEditing] = useState<Event | null>(null),
    [hotkeys, setHotkeys] = useState(defaultKeys),
    [keysEnabled, setKeysEnabled] = useState(true),
    [keysOpen, setKeysOpen] = useState(false),
    [modal, setModal] = useState<{
      title: string;
      body: string;
      action: () => void;
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
    [assignmentDraft, setAssignmentDraft] = useState<Record<string, string>>({}),
    [competitorEdit, setCompetitorEdit] = useState<Partial<Competitor> | null>(
      null,
    ),
    [userEdit, setUserEdit] = useState<
      (Partial<Profile> & { username?: string; password?: string }) | null
    >(null);
  const state = workspace?.snapshot;
  const profile = state?.profile;
  const server = !!profile && canManage(profile);
  const canManageScoringConfig = !!profile && canManageScoringConfiguration(profile);
  const organizer = profile?.role === "server_admin";
  const technical = (profile?.slot ?? 1) <= 3;
  const canViewPoints =
    adminUnlocked && showPoints && !!adminUnlockToken && state?.pointAccess === true;
  const viewingSlot = server
    ? tab === "Performance"
      ? performanceViewSlot
      : technicalViewSlot
    : (profile?.slot ?? 1);
  const active = state?.competitors.find(
    (c) => c.status === "active" && !c.archived,
  );
  const current = state?.competitors.find(
    (c) => c.id === (selected ?? active?.id),
  );
  const own = state?.submissions.find(
    (s) => s.competitor_id === current?.id && s.user_id === profile?.id,
  );
  const displayed = state?.submissions.find(
    (s) =>
      s.competitor_id === current?.id &&
      s.slot === viewingSlot &&
      (server || s.user_id === profile?.id),
  );
  const visibleSubmissions =
    profile && state ? detailSubmissions(profile, state.submissions) : [];
  const personalSubmissions =
    profile && state ? ownSubmissions(profile, state.submissions) : [];
  const canScore =
    !!profile &&
    isAssignedJudge(profile) &&
    profile.slot === viewingSlot &&
    ((tab === "Technical" && profile.slot <= 3) ||
      (tab === "Performance" && profile.slot >= 4)) &&
    !!current &&
    !current.archived &&
    (server || !state.assignments || state.assignments.some(
      (a) => a.division === current.division && a.user_id === profile.id && a.slot === profile.slot,
    )) &&
    (current.status === "active" || !!own);
  const allDivisions = Array.from(
    new Set([
      ...divisions,
      ...(state?.divisions ?? []),
      ...(state?.competitors.map((c) => c.division) ?? []),
    ]),
  );
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
  const divisionProfiles = (state?.profiles ?? []).filter(
    (p) => p.active && p.role === "judge",
  );
  const currentAssignmentDraft = Object.fromEntries(
    divisionAssignments.map((a) => [String(a.slot), a.user_id]),
  );
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
      const judges = (state?.assignments ?? [])
        .filter((assignment) => assignment.division === competitor.division)
        .sort((a, b) => a.slot - b.slot);
      const entries = judges.map((judge) => {
        const judgeProfile = state?.profiles?.find((p) => p.id === judge.user_id);
        const submission = state?.submissions.find(
          (s) => s.competitor_id === competitor.id && s.user_id === judge.user_id,
        );
        return {
          ...judge,
          name: judgeProfile?.name ?? `Judge ${judge.slot}`,
          status: submission?.finished
            ? "Finished"
            : submission && submission.version > 0
              ? "In progress"
              : "Not started",
        };
      });
      const complete = entries.length === 5 && entries.every((entry) => entry.status === "Finished");
      const started = entries.some((entry) => entry.status !== "Not started");
      return {
        competitor,
        entries,
        complete,
        started,
        stateLabel: complete ? "Complete" : competitor.status === "active" ? "Active · in progress" : started ? "Started · incomplete" : "Not started · locked",
      };
    });
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
    const viewer = next.snapshot.profile;
    if (viewer.role === "judge" && !canManage(viewer)) {
      const ownSubmissions = next.snapshot.submissions.filter((submission) => submission.user_id === viewer.id);
      const ownCompetitorIds = new Set(ownSubmissions.map((submission) => submission.competitor_id));
      const allowedActiveDivisions = new Set((next.snapshot.assignments ?? [])
        .filter((assignment) => assignment.user_id === viewer.id && assignment.slot === viewer.slot)
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
  const fetchState = useCallback(
    () =>
      api(
        "state",
        undefined,
        adminUnlocked && showPoints && adminUnlockToken
          ? { adminUnlockToken }
          : undefined,
      ),
    [adminUnlocked, adminUnlockToken, showPoints],
  );
  const refresh = useCallback(async () => {
    if (demo || busy.current || ref.current?.queue.length || !navigator.onLine)
      return;
    busy.current = true;
    try {
      const snapshot: Snapshot = await fetchState();
      chain.current = chain.current.then(async () => {
        if (!ref.current?.queue.length) await commit({ snapshot, queue: [] });
      });
      await chain.current;
    } catch (e) {
      setSyncError((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [commit, fetchState]);
  const sync = useCallback(async () => {
    if (demo || busy.current || !navigator.onLine || !ref.current?.queue.length)
      return;
    busy.current = true;
    setSyncing(true);
    try {
      while (ref.current?.queue.length) {
        const entry = ref.current.queue[0];
        const result = await api("sync", entry);
        const clientRevision = entry.scoring_config_revision ?? ref.current?.snapshot.scoringConfigRevision ?? 1;
        if (Number(result.scoringConfigRevision) > clientRevision) {
          setScoringReconciliationNotice(
            `An offline score selection from configuration v${clientRevision} was synced using current rules v${result.scoringConfigRevision}.`,
          );
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
    try {
      const k = localStorage.getItem("hidc-hotkeys");
      if (k) setHotkeys({ ...defaultKeys, ...JSON.parse(k) });
    } catch {}
    setKeysEnabled(localStorage.getItem("hidc-keys-enabled") !== "false");
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
          if (local?.snapshot.profile.role === "server_admin")
            setTab("Server Access Control");
          if (local?.snapshot.profile.slot && local.snapshot.profile.slot > 3)
            setTab("Performance");
        } else {
          if (!navigator.onLine) {
            const id = localStorage.getItem("hidc-last-user");
            const cached = id ? await readLocal(id) : undefined;
            if (cached) {
              await commit(cached);
              setTab(
                cached.snapshot.profile.role === "server_admin"
                  ? "Server Access Control"
                  : (cached.snapshot.profile.slot ?? 1) > 3
                    ? "Performance"
                    : "Technical",
              );
            }
            return;
          }
          const session = await supabase?.auth.getSession();
          if (session?.data.session) {
            const local = await readLocal(session.data.session.user.id);
            if (local) {
              await commit(local);
              if (local.snapshot.profile.role === "server_admin")
                setTab("Server Access Control");
              if ((local.snapshot.profile.slot ?? 1) > 3) setTab("Performance");
            }
            if (navigator.onLine && !local?.queue.length) {
              const snapshot: Snapshot = await api("state");
              await commit({ snapshot, queue: [] });
              setTab(
                snapshot.profile.role === "server_admin"
                  ? "Server Access Control"
                  : (snapshot.profile.slot ?? 1) > 3
                    ? "Performance"
                    : "Technical",
              );
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
    const preferences = isAppearancePreferences(profile.appearance_preferences)
      ? profile.appearance_preferences
      : defaultAppearance;
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
  ]);
  useEffect(() => {
    if (online && workspace?.appearancePending) void syncAppearance();
  }, [online, workspace?.snapshot.profile.id, workspace?.appearancePending?.updatedAt, syncAppearance]);
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
    const timer = setInterval(() => {
      void sync();
      void refresh();
      void syncAppearance();
    }, 5000);
    void sync();
    void syncAppearance();
    const channel =
      !demo && supabase
        ? supabase
            .channel("roster")
            .on(
              "postgres_changes",
              { event: "*", schema: "public", table: "competitors" },
              () => void refresh(),
            )
            .on(
              "postgres_changes",
              { event: "UPDATE", schema: "public", table: "live_signal" },
              () => void refresh(),
            )
            .subscribe()
        : null;
    return () => {
      clearInterval(timer);
      if (channel) void supabase?.removeChannel(channel);
    };
  }, [ready, state?.profile.id, online, sync, refresh, syncAppearance]);
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
    chain.current = chain.current.then(async () => {
      try {
        const latest = ref.current!;
        const s = latest.snapshot.submissions.find(
          (s) =>
            s.competitor_id === competitorId &&
            s.user_id === latest.snapshot.profile.id,
        );
        if (kind === "performance" && typeof payload.index === "number") {
          const values = [...(s?.performance ?? [0, 0, 0, 0, 0, 0])];
          values[payload.index] = Number(payload.value);
          payload = { values };
        }
        const op: Operation = {
          id: uid(),
          competitor_id: competitorId,
          expected_version: s?.version ?? 0,
          kind,
          payload,
          scoring_config_revision: latest.snapshot.scoringConfigRevision ?? 1,
        };
        const snapshot = applyLocal(latest.snapshot, op);
        await commit({ snapshot, queue: demo ? [] : [...latest.queue, op] });
        setNotice(
          kind === "put_event"
            ? "Event recorded · saved on this laptop"
            : kind === "finish"
              ? "Submission finished · saved on this laptop"
              : "Change saved on this laptop",
        );
      } catch (e) {
        setSyncError(
          `Local save failed: ${(e as Error).message}. Do not close this page.`,
        );
      }
      void sync();
    });
  };
  useEffect(() => {
    setTrick("");
    setLevel(1);
    setFeatures([]);
    setEditing(null);
  }, [active?.id]);
  const clear = () => {
    setTrick("");
    setLevel(1);
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
  const finish = () =>
    setModal({
      title: "Finish This Submission?",
      body: "Your work is saved on this laptop. You can reopen your own entry later for corrections. Pending changes still need to sync.",
      action: () => persistAction("finish", { finished: true }),
    });
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
        keysOpen ||
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
      let action = Object.keys(hotkeys).find((a) => hotkeys[a] === combined);
      if (!action)
        action = Object.keys(hotkeys).find((a) => hotkeys[a] === key);
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
      else if (action.startsWith("level:"))
        setLevel(Number(action.split(":")[1]));
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
      setTab(
        snapshot.profile.role === "server_admin"
          ? "Server Access Control"
          : snapshot.profile.slot! > 3
            ? "Performance"
            : "Technical",
      );
      setPassword("");
      setSyncError("");
    } catch (e) {
      setSyncError((e as Error).message);
    } finally {
      setLoginBusy(false);
    }
  }
  function openProfileSettings() {
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
    setAdminPasswordBusy(true);
    setAdminPasswordError("");
    try {
      const result = await api("verify-admin", { password: adminPassword });
      if (!result.unlockToken)
        throw new Error("The server did not provide an Admin unlock.");
      setAdminUnlockToken(result.unlockToken);
      setAdminUnlocked(true);
      setShowPoints(false);
      setAdminPassword("");
    } catch (e) {
      setAdminPasswordError((e as Error).message);
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
      });
      if (!snapshot.pointAccess)
        throw new Error("Admin access expired. Enter the Admin password again.");
      await commit({ snapshot, queue: ref.current?.queue ?? [] });
      setShowPoints(true);
    } catch (error) {
      setAdminUnlocked(false);
      setAdminUnlockToken(null);
      setShowPoints(false);
      setAdminPasswordError((error as Error).message);
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
        } else if (action === "save") {
          const index = next.snapshot.competitors.findIndex(
            (c) => c.id === d.id,
          );
          if (index < 0) next.snapshot.competitors.push({ ...d, id: uid() });
          else next.snapshot.competitors[index] = d;
        } else if (action === "assignments") {
          const assignment = data as { division: string; assignments: { slot: number; user_id: string }[] };
          next.snapshot.assignments = [
            ...(next.snapshot.assignments ?? []).filter((row) => row.division !== assignment.division),
            ...assignment.assignments.map((row) => ({ ...row, division: assignment.division })),
          ];
        } else if (action === "user")
          throw new Error(
            "Account changes require a connected Supabase project.",
          );
        await commit(next);
      } else {
        await api("manage", { action, data });
        await refresh();
      }
      setCompetitorEdit(null);
      setUserEdit(null);
      setNotice("Changes saved");
      return true;
    } catch (e) {
      setSyncError((e as Error).message);
      return false;
    }
  }
  async function addDivision(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = newDivision.trim();
    if (!name) return;
    if (await manage("division", { name })) {
      setNewDivision("");
      setDivisionFormOpen(false);
    }
  }
  async function switchDemo(value: string) {
    const role = value === "organizer" ? "server_admin" : "judge";
    const slot = role === "judge" ? Number(value) : 1;
    const snapshot = blankDemo(slot, role);
    const local = await readLocal(snapshot.profile.id);
    await commit(local ?? { snapshot, queue: [] });
    localStorage.setItem("hidc-demo-user", snapshot.profile.id);
    setAdminUnlockToken(null);
    setAdminUnlocked(false);
    setShowPoints(false);
    setSelected(null);
    setTab(
      role === "server_admin"
        ? "Server Access Control"
        : slot > 3
          ? "Performance"
          : "Technical",
    );
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
          ...(technical ? {} : { Score: canViewPoints ? r.total : "***" }),
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
          </div>
          <span className="eyebrow">
            HOUSTON INTERNATIONAL DIABOLO COMPETITION
          </span>
          <h1>Judge Sign In</h1>
          <p className="login-help">
            Use the username and password provided by the event organizer.
            <br />Need access help? Contact the organizer.
          </p>
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
    ...(server
      ? ["Technical", "Performance"]
      : profile?.role === "judge"
        ? [technical ? "Technical" : "Performance"]
        : []),
    "Score Details",
    "Saved Competitors",
    "Rankings",
    "Admin",
  ];
  return (
    <div className="app-shell" data-template={appearance.template}>
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
              {organizer
                ? "Server organizer"
                : `${technical ? "Technical" : "Performance"} Judge ${profile?.slot}${profile && isAdministrator(profile) ? " · Administrator" : ""}`}
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
      <nav>
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
            value={organizer ? "organizer" : (profile?.slot ?? 1)}
            onChange={(e) => void switchDemo(e.target.value)}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n < 4 ? "Technical" : "Performance"} Judge {n}
              </option>
            ))}
            <option value="organizer">Server organizer</option>
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
              void sync();
            }}
          >
            Retry Sync
          </button>
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
              {organizer ? "ORGANIZER" : `JUDGE ${profile?.slot}`}
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
                  <button onClick={() => setKeysOpen(true)}>
                    <Keyboard size={16} /> Hotkeys <kbd>?</kbd>
                  </button>
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
                  {displayed?.finished
                    ? "Finished"
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
                      value={viewingSlot}
                      onChange={(e) => {
                        const slot = Number(e.target.value);
                        if (tab === "Technical") setTechnicalViewSlot(slot);
                        else setPerformanceViewSlot(slot);
                        clear();
                      }}
                    >
                      {(tab === "Technical" ? [1, 2, 3] : [4, 5]).map(
                        (slot) => (
                          <option value={slot} key={slot}>
                            Judge {slot}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                )}
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
                  Finish Scoring <Check size={17} />
                </button>
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
                  <div className="modifiers">
                    <section className="panel">
                      <div className="panel-heading">
                        <h3>
                          02 <span>Level</span>
                        </h3>
                      </div>
                      <div className="level-buttons">
                        {[0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
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
                  </div>
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
                          </small>
                        )}
                      </b>
                    </div>
                    <button className="clear-button" onClick={clear}>
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
                  </div>
                </div>
              </div>
            ) : (
              <div className="performance-layout">
                <div className="panel category-panel">
                  {categories.map((category, i) => (
                    <div className="category" key={category}>
                      <div>
                        <span className="category-index">0{i + 1}</span>
                        <div>
                          <h3>{category}</h3>
                        </div>
                        <strong>
                          {canViewPoints
                            ? (displayed?.performance[i] ?? 0).toFixed(1)
                            : "***"}
                        </strong>
                      </div>
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
                    </div>
                  ))}
                </div>
                <aside className="panel performance-summary">
                  <h2>Performance</h2>
                  <div className="big-total">
                    {canViewPoints
                      ? (displayed?.performance.reduce((a, b) => a + b, 0) ?? 0).toFixed(1)
                      : "***"}
                    <span>/ 30</span>
                  </div>
                  {categories.map((c, i) => (
                    <div className="summary-row" key={c}>
                      <span>{c}</span>
                      <b>{canViewPoints ? (displayed?.performance[i] ?? 0).toFixed(1) : "***"}</b>
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
                              ? "Finished"
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
                        {!technical && <td>{canViewPoints ? fmt(r.total) : "***"}</td>}
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            {!state.personal?.length && (
              <div className="empty-state">
                <Trophy />
                <h3>No Finished Rankings Yet</h3>
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
            {!canViewPoints && <p className="masked-points-note" role="status">Unlock Admin and turn on Show points to export numeric score details.</p>}
            {visibleSubmissions.map((s) => (
              <details className="submission-detail" key={s.id}>
                <summary>
                  <span>
                    {
                      state.competitors.find((c) => c.id === s.competitor_id)
                        ?.name
                    }
                  </span>
                  <span>Judge {s.slot}</span>
                  <span>
                    {s.finished ? "Finished" : "Draft"}
                    {s.dq ? " · DQ" : ""}
                    {canViewPoints
                      ? ` · Total ${s.total === undefined ? "***" : fmt(s.total)}`
                      : " · Total ***"}
                  </span>
                </summary>
                {server && (
                  <div className="row-actions">
                    <button
                      disabled={demo}
                      onClick={() =>
                        setModal({
                          title: s.finished
                            ? "Reopen this submission?"
                            : "Mark this submission finished?",
                          body: "This change is recorded in the audit log.",
                          action: () => {
                            void api("review", {
                              id: s.id,
                              version: s.version,
                              finished: !s.finished,
                              dq: s.dq,
                            })
                              .then(refresh)
                              .catch((e) => setSyncError(e.message));
                          },
                        })
                      }
                    >
                      {s.finished ? "Reopen submission" : "Mark finished"}
                    </button>
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
                {s.slot < 4
                  ? s.events.map((e, i) => (
                      <div className="detail-event" key={e.id}>
                        <b>
                          {i + 1}. {e.trick}
                        </b>
                        <span>
                          {deductions.includes(e.trick)
                            ? "Deduction"
                            : `L${e.level} · ${e.features.join(" + ") || "No features"}`}
                        </span>
                        <span>{canViewPoints && e.value !== undefined ? `${fmt(e.value)} points` : "*** points"}</span>
                        <time>{new Date(e.at).toLocaleString()}</time>
                      </div>
                    ))
                  : categories.map((c, i) => (
                      <div className="detail-event" key={c}>
                        <span>{c}</span>
                        <b>{canViewPoints ? (s.performance[i] ?? 0).toFixed(1) : "***"}</b>
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
                {!demo && !!state.audit?.length && (
                  <button
                    style={{ margin: 20 }}
                    onClick={async () => {
                      try {
                        const older = await api(
                          `audit?before=${state.audit![state.audit!.length - 1].id}`,
                          undefined,
                          adminUnlockToken ? { adminUnlockToken } : undefined,
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
                personalScoreExportRows(profile!, ordered, state.competitors),
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
                    {s.finished ? "Finished" : "Draft"}
                    {s.dq ? " · DQ" : ""}
                  </span>
                  <span>Total {canViewPoints && s.total !== undefined ? fmt(s.total) : "***"}</span>
                </summary>
                {s.slot < 4
                  ? s.events.map((e, i) => (
                      <div className="detail-event" key={e.id}>
                        <span>
                          {i + 1}. {e.trick}
                        </span>
                        <b>{canViewPoints && e.value !== undefined ? `${fmt(e.value)} points` : "*** points"}</b>
                      </div>
                    ))
                  : categories.map((c, i) => (
                      <div className="detail-event" key={c}>
                        <span>{c}</span>
                        <b>{canViewPoints ? (s.performance[i] ?? 0).toFixed(1) : "***"}</b>
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
                  <label>
                    Division
                    <select
                      aria-label="Division judge assignments"
                      value={assignmentDivision}
                      onChange={(event) => {
                        const nextDivision = event.target.value;
                        setAssignmentDivision(nextDivision);
                        setAssignmentDraft(Object.fromEntries(
                          (state.assignments ?? [])
                            .filter((a) => a.division === nextDivision)
                            .map((a) => [String(a.slot), a.user_id]),
                        ));
                      }}
                    >
                      {allDivisions.map((division) => <option key={division}>{division}</option>)}
                    </select>
                  </label>
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
                </div>
              </div>
              <p>Choose five active judges, one for each scoring slot. The same group scores this division; a judge can be assigned to multiple divisions. Assignments lock after scoring starts.</p>
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
                  <button type="button" onClick={() => setDivisionFormOpen(false)}>Cancel</button>
                  <button className="primary" disabled={demo || !newDivision.trim()}>Save Division</button>
                </form>
              )}
              <div className="division-assignment-grid">
                {[1, 2, 3, 4, 5].map((slot) => {
                  const selectedId = assignmentDraft[String(slot)] ?? currentAssignmentDraft[String(slot)] ?? "";
                  const usedElsewhere = new Set([1, 2, 3, 4, 5]
                    .filter((otherSlot) => otherSlot !== slot)
                    .map((otherSlot) => assignmentDraft[String(otherSlot)] ?? currentAssignmentDraft[String(otherSlot)] ?? ""));
                  return (
                    <label key={slot}>
                      {slot < 4 ? "Technical" : "Performance"} · Judge {slot}
                      <select
                        value={selectedId}
                        onChange={(event) => setAssignmentDraft((prior) => ({ ...prior, [String(slot)]: event.target.value }))}
                      >
                        <option value="">Select assigned judge</option>
                        {divisionProfiles.filter((p) => p.slot === slot).map((p) => (
                          <option key={p.id} value={p.id} disabled={usedElsewhere.has(p.id)}>
                            {p.name} · @{p.username}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
                <button
                  className="primary"
                  disabled={
                    [1, 2, 3, 4, 5].some((slot) => !(assignmentDraft[String(slot)] ?? currentAssignmentDraft[String(slot)])) ||
                    new Set([1, 2, 3, 4, 5].map((slot) => assignmentDraft[String(slot)] ?? currentAssignmentDraft[String(slot)] ?? "")).size !== 5
                  }
                  onClick={() => void manage("assignments", {
                    division: assignmentDivision,
                    assignments: [1, 2, 3, 4, 5].map((slot) => ({
                      slot,
                      user_id: assignmentDraft[String(slot)] ?? currentAssignmentDraft[String(slot)],
                    })),
                  })}
                >
                  Save Judge Group
                </button>
              </div>
            </section>
            <section className="panel records progress-overview">
              <div className="panel-heading">
                <h3>Competitor Progress</h3>
                <span className="muted">Green only when all five assigned judges finish</span>
              </div>
              <div className="progress-table-wrap">
                <div className="progress-table-header" aria-hidden="true">
                  <span>Order</span><span>Competitor · Division</span><span>Overall</span>
                  {[1, 2, 3, 4, 5].map((slot) => <span key={slot}>Judge {slot}</span>)}
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
                        {entries.length === 5 ? entries.map((entry) => (
                          <span
                            key={entry.slot}
                            className={`judge-progress ${entry.status === "Finished" ? "finished" : entry.status === "In progress" ? "draft" : "not-started"}`}
                            title={`Judge ${entry.slot} · ${entry.name} · ${entry.status}`}
                          >
                            <b>J{entry.slot} · {entry.name}</b><em>{entry.status}</em>
                          </span>
                        )) : <span className="assignment-warning">Assign five judges to this division</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
            {canManageScoringConfig && adminUnlocked && adminUnlockToken ? (
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
                  onClick={() =>
                    setCompetitorEdit({
                      name: "",
                      division: "Individual Open",
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
                          <td>{c.archived ? "Archived" : c.status}</td>
                          <td>
                            <div className="row-actions">
                              <button onClick={() => setCompetitorEdit(c)}>
                                <Pencil size={13} /> Edit
                              </button>
                              <button
                                disabled={
                                  c.archived || c.status === "active" ||
                                  (c.status === "upcoming" && c.id !== nextUpcoming?.id) ||
                                  (c.status === "locked" && !state.submissions.some((s) => s.competitor_id === c.id))
                                }
                                onClick={() =>
                                  setModal({
                                    title: `Activate ${c.name}?`,
                                    body: "This switches the shared active competitor for every judge.",
                                    action: () =>
                                      void manage("activate", { id: c.id }),
                                  })
                                }
                              >
                                Activate
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
                  <Users size={16} /> Judge Access
                </h3>
                <button
                  onClick={() =>
                    setUserEdit({
                      name: "",
                      username: "",
                      password: "",
                      slot: 1,
                      active: true,
                    })
                  }
                >
                  <Plus size={15} /> Create Judge
                </button>
              </div>
              {demo && (
                <div className="info-note">
                  Demo accounts are previews. Connect Supabase to create and
                  manage real accounts.
                </div>
              )}
              <div className="judge-cards">
                {[1, 2, 3, 4, 5].map((slot) => {
                  const p = state.profiles?.find(
                    (p) => p.slot === slot && p.active,
                  );
                  return (
                    <div key={slot}>
                      <div className="avatar">
                        {p?.avatar_url ? <img src={p.avatar_url} alt={`${p.name} profile`} /> : p ? p.name.trim().split(/\s+/).slice(0, 2).map((n) => n[0]?.toUpperCase()).join("") : `J${slot}`}
                      </div>
                      <h3>
                        {slot < 4 ? "Technical" : "Performance"} {slot}
                      </h3>
                      <p>
                        {p?.name ?? "Unassigned"}
                        {p && !canEditJudge(p) ? " · Administrator" : ""}
                      </p>
                      {p && <small className="judge-profile-meta">@{p.username} · Judge {p.slot} · {p.active ? "Active" : "Inactive"} · {isAdministrator(p) ? "Administrator" : "Judge"}</small>}
                      <button
                        disabled={!!p && !canEditJudge(p)}
                        onClick={() =>
                          setUserEdit(
                            p
                              ? {
                                  ...p,
                                  username: p.username ?? "",
                                  password: "",
                                }
                              : {
                                  name: "",
                                  username: "",
                                  password: "",
                                  slot,
                                  active: true,
                                },
                          )
                        }
                      >
                        {p && !canEditJudge(p)
                          ? "Protected administrator"
                          : p
                            ? "Manage account"
                            : "Assign Judge"}
                      </button>
                    </div>
                  );
                })}
              </div>
              {(state.profiles ?? [])
                .filter((p) => p.active && canEditJudge(p) && state.profiles?.find((candidate) => candidate.slot === p.slot && candidate.active)?.id !== p.id)
                .map((p) => (
                  <div className="detail-event" key={p.id}>
                    {p.avatar_url ? <img className="admin-roster-avatar" src={p.avatar_url} alt={`${p.name} profile`} /> : null}
                    <span>{p.name} · @{p.username} · {p.slot! < 4 ? "Technical" : "Performance"} Judge {p.slot}</span>
                    <button onClick={() => setUserEdit({ ...p, username: p.username ?? "", password: "" })}>Manage Account</button>
                  </div>
                ))}
              {state.profiles
                ?.filter((p) => !p.active && canEditJudge(p))
                .map((p) => (
                  <div className="detail-event" key={p.id}>
                    {p.avatar_url ? <img className="admin-roster-avatar" src={p.avatar_url} alt={`${p.name} profile`} /> : null}
                    {p.name} · @{p.username} · Judge {p.slot} · Inactive
                    <button
                      onClick={() =>
                        setUserEdit({
                          ...p,
                          username: p.username ?? "",
                          password: "",
                        })
                      }
                    >
                      Edit Account
                    </button>
                  </div>
                ))}
            </section>
            <section className="panel records admin-tab-password-panel">
              <div className="panel-heading">
                <h3>
                  <Shield size={17} /> Shared Admin Tab Password
                </h3>
                <span className="pill">Administrators only</span>
              </div>
              <p>
                Change the shared password everyone must enter to open the
                Admin tab, including administrators.
              </p>
              <form
                className="admin-tab-password-form"
                onSubmit={changeAdminTabPassword}
              >
                <label>
                  New shared password
                  <PasswordField
                    autoComplete="new-password"
                    minLength={6}
                    maxLength={256}
                    required
                    value={newAdminTabPassword}
                    onChange={(e) => setNewAdminTabPassword(e.target.value)}
                  />
                </label>
                <label>
                  Confirm new password
                  <PasswordField
                    autoComplete="new-password"
                    minLength={6}
                    maxLength={256}
                    required
                    value={confirmAdminTabPassword}
                    onChange={(e) => setConfirmAdminTabPassword(e.target.value)}
                  />
                </label>
                {adminTabPasswordMessage && (
                  <p className="admin-tab-password-message muted" role="status">
                    {adminTabPasswordMessage}
                  </p>
                )}
                <button className="primary">
                  Update Shared Password <ArrowRight size={16} />
                </button>
              </form>
            </section>
            <section className="panel records">
              <div className="panel-heading">
                <h3>
                  <Trophy size={17} /> Global Rankings
                </h3>
                <span className="muted">70 technical + 30 performance</span>
              </div>
              <div className="info-note">
                Exhibition is excluded. Incomplete submissions stay pending.
                Rankings remain provisional until all judges finish. DQ
                competitors rank last.
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
                  .map((r) => ({
                    Rank: r.rank,
                    Competitor: r.competitor.name,
                    Division: r.competitor.division,
                    Order: r.competitor.position,
                    J1: r.technical[0],
                    J2: r.technical[1],
                    J3: r.technical[2],
                    J4: r.performance[0],
                    J5: r.performance[1],
                    Raw: r.raw,
                    Scaled: r.scaled,
                    Performance: r.average,
                    Final: r.final,
                    Complete: r.complete,
                    DQ: r.dq,
                  }));
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
                .map((d) => (
                  <div key={d}>
                    <h3 className="division-title">{d}</h3>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            {[
                              "Rank",
                              "Competitor",
                              "J1",
                              "J2",
                              "J3",
                              "J4",
                              "J5",
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
                            ? state.rankings
                                ?.filter((r) => r.competitor.division === d)
                                .map((r) => (
                              <tr key={r.competitor.id}>
                                <td>{r.rank ?? "—"}</td>
                                <td>{r.competitor.name}</td>
                                {[
                                  ...r.technical,
                                  ...r.performance,
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
                                ))
                            : state.competitors
                                .filter((competitor) => competitor.division === d)
                                .sort((a, b) => a.position - b.position)
                                .map((competitor) => (
                                  <tr key={competitor.id}>
                                    <td>***</td>
                                    <td>{competitor.name}</td>
                                    {Array.from({ length: 9 }, (_, index) => <td key={index}>***</td>)}
                                    <td>—</td>
                                  </tr>
                                ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
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
          <div className="profile-avatar-control">
            <span className="avatar profile-avatar-large">
              {profile.avatar_url ? (
                <img src={profile.avatar_url} alt={`${profile.name} profile`} />
              ) : (
                profile.name.trim().split(/\s+/).slice(0, 2).map((n) => n[0]?.toUpperCase()).join("")
              )}
            </span>
            <div>
              <b>Profile picture</b>
              <p>JPEG, PNG, or WebP · up to 2 MB</p>
            </div>
            <label className="button-like">
              <Camera size={15} /> Replace
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={profileBusy || !online || demo}
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  e.currentTarget.value = "";
                  if (file) void changeAvatar(file);
                }}
              />
            </label>
            {profile.avatar_url && (
              <button type="button" disabled={profileBusy || !online || demo} onClick={() => void removeAvatar()}>
                <Trash2 size={15} /> Remove
              </button>
            )}
          </div>
          {demo && <p className="info-note">Demo mode: account changes and profile pictures are not saved to a live account.</p>}
          <form className="profile-settings-form" onSubmit={saveProfileSettings}>
            <label>
              Display name
              <input required maxLength={100} value={profileName} onChange={(e) => setProfileName(e.target.value)} />
            </label>
            <label>
              Username
              <input
                required minLength={3} maxLength={32}
                pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,31}"
                autoComplete="username"
                value={profileUsername}
                onChange={(e) => setProfileUsername(e.target.value)}
              />
            </label>
            <p className="profile-help">Your username is used to sign in. It must be unique.</p>
            <label>
              Current password <span className="muted">(required for username or password changes)</span>
              <PasswordField autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
            </label>
            <label>
              New password <span className="muted">(optional · minimum 6 characters)</span>
              <PasswordField minLength={6} maxLength={256} autoComplete="new-password" value={newLoginPassword} onChange={(e) => setNewLoginPassword(e.target.value)} />
            </label>
            <label>
              Confirm new password
              <PasswordField minLength={6} maxLength={256} autoComplete="new-password" value={confirmLoginPassword} onChange={(e) => setConfirmLoginPassword(e.target.value)} />
            </label>
            <p className="password-privacy-notice">Use a password only for this scoring system. Event organizers can reset account access; do not reuse a personal password.</p>
            <div className="profile-settings-actions">
              <button className="primary" disabled={profileBusy || (!online && !demo)}>
                {profileBusy ? "Saving…" : "Save Profile"}
              </button>
            </div>
          </form>
          <div className="profile-local-settings">
            <AppearanceSettings
              initial={isAppearancePreferences(profile?.appearance_preferences)
                ? profile.appearance_preferences
                : defaultAppearance}
              online={online && !demo}
              demo={demo}
              onPreview={previewAppearance}
              onSave={saveAppearancePreferences}
            />
            {appearanceSyncError && <p className="error appearance-sync-error" role="status">{appearanceSyncError}</p>}
            <div className="profile-setting-row">
              <div><b>Hotkeys</b><span>Configure your local keyboard shortcuts.</span></div>
              <button type="button" onClick={() => { setSettingsOpen(false); setKeysOpen(true); }}>Configure</button>
            </div>
            <div className="profile-setting-row">
              <div><b>Offline cache</b><span>Clears only this account’s saved workspace on this browser.</span></div>
              <button
                type="button"
                disabled={!!workspace?.queue.length}
                onClick={() => {
                  setSettingsOpen(false);
                  setModal({
                    title: "Clear Your Offline Cache?",
                    body: workspace?.queue.length
                      ? "Sync pending score changes first."
                      : "This removes only your local workspace from this browser and signs you out. It does not delete online profiles or scoring records.",
                    action: () => void clearOwnOfflineCache(),
                  });
                }}
              >Clear Cache</button>
            </div>
            {workspace?.queue.length ? <p className="profile-help">Sync {workspace.queue.length} pending score change(s) before clearing your cache or signing out.</p> : null}
          </div>
          <div className="profile-dialog-footer">
            <button type="button" onClick={() => void signOut()}><LogOut size={15} /> Sign Out</button>
          </div>
          {profileMessage && <p className={profileMessageError ? "error" : "success"} role="status">{profileMessage}</p>}
          {!online && !demo && <p className="profile-help">Profile, username, password, and picture changes require an online connection. Appearance and hotkeys remain available offline and sync when reconnected.</p>}
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
          <p>{modal.body}</p>
          <div className="dialog-actions">
            <button onClick={() => setModal(null)}>Cancel</button>
            <button
              className="primary"
              onClick={() => {
                modal.action();
                setModal(null);
              }}
            >
              Confirm
            </button>
          </div>
        </Dialog>
      )}
      {keysOpen && (
        <Dialog title="Hotkeys" close={() => setKeysOpen(false)}>
          <p>
            Two-character shortcuts are pressed in sequence within 0.9 seconds.
            Shortcuts pause while typing in a field. Each binding must be
            unique.
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={keysEnabled}
              onChange={(e) => {
                setKeysEnabled(e.target.checked);
                localStorage.setItem(
                  "hidc-keys-enabled",
                  String(e.target.checked),
                );
              }}
            />{" "}
            Enable keyboard shortcuts
          </label>
          <div className="hotkey-list">
            {Object.entries(hotkeys).map(([action, key]) => (
              <label key={action}>
                <span>
                  {action.replace("level:", "Level ").replace("tab:", "Go to ")}
                </span>
                <input
                  aria-label={`Hotkey for ${action}`}
                  value={key}
                  onChange={(e) =>
                    setHotkeys({ ...hotkeys, [action]: e.target.value })
                  }
                />
              </label>
            ))}
          </div>
          <div className="dialog-actions">
            <button onClick={() => setHotkeys(defaultKeys)}>
              Reset Defaults
            </button>
            <button
              className="primary"
              onClick={() => {
                const vals = Object.values(hotkeys).filter(Boolean);
                if (new Set(vals).size !== vals.length) {
                  setSyncError(
                    "Hotkeys must be unique. Resolve duplicate bindings before saving.",
                  );
                  return;
                }
                localStorage.setItem("hidc-hotkeys", JSON.stringify(hotkeys));
                setKeysOpen(false);
              }}
            >
              Save hotkeys
            </button>
          </div>
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
              if (competitorEdit.archived || competitorEdit.dq) {
                setModal({
                  title: "Confirm Competitor Status Change?",
                  body: "Archiving or disqualifying this competitor changes access and results. Scores and audit history are preserved.",
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
            <label className="checkbox">
              <input
                type="checkbox"
                checked={competitorEdit.archived}
                onChange={(e) =>
                  setCompetitorEdit({
                    ...competitorEdit,
                    archived: e.target.checked,
                    status: e.target.checked ? "locked" : competitorEdit.status,
                  })
                }
              />{" "}
              Archive competitor (preserves scores)
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={() => setCompetitorEdit(null)}>
                Cancel
              </button>
              <button className="primary">Save Competitor</button>
            </div>
          </form>
        </Dialog>
      )}
      {userEdit && (
        <Dialog
          title={userEdit.id ? "Manage Judge Account" : "Create Judge Account"}
          close={() => setUserEdit(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void manage("user", {
                ...userEdit,
                password: userEdit.password || undefined,
              });
            }}
          >
            <label>
              Username
              <input
                type="text"
                required
                value={userEdit.username ?? ""}
                onChange={(e) =>
                  setUserEdit({ ...userEdit, username: e.target.value })
                }
              />
            </label>
            <label>
              {userEdit.id
                ? "New password (leave blank to keep)"
                : "Password (6+ characters)"}
              <PasswordField
                minLength={6}
                required={!userEdit.id}
                value={userEdit.password ?? ""}
                onChange={(e) =>
                  setUserEdit({ ...userEdit, password: e.target.value })
                }
              />
            </label>
            <label>
              Assigned slot
              <select
                value={userEdit.slot ?? 1}
                onChange={(e) =>
                  setUserEdit({ ...userEdit, slot: Number(e.target.value) })
                }
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n < 4 ? "Technical" : "Performance"} Judge {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={userEdit.active ?? true}
                onChange={(e) =>
                  setUserEdit({ ...userEdit, active: e.target.checked })
                }
              />{" "}
              Account active
            </label>
            <p>
              Deactivate the previous holder before reassigning a slot. Existing
              submissions remain attributed to their original author.
            </p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setUserEdit(null)}>
                Cancel
              </button>
              <button className="primary">Save Account</button>
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
