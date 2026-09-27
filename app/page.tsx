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
} from "@/lib/access";
import { api, demo, supabase } from "@/lib/supabase";
import { applyLocal, clearLocal, LocalWorkspace, readLocal, writeLocal } from "@/lib/local";
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
import {
  detailExportRows,
  detailSubmissions,
  ownSubmissions,
  personalScoreExportRows,
} from "@/lib/scoped";
import { eventScore, total } from "@/lib/scoring";

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
const blankDemo = (slot = 1, role: Profile["role"] = "judge"): Snapshot => ({
  profile: {
    id: `demo-user-${role === "server_admin" ? "organizer" : slot}`,
    name: role === "server_admin" ? "Event organizer" : `Demo Judge ${slot}`,
    role,
    slot: role === "judge" ? slot : null,
    active: true,
  },
  competitors: demoCompetitors,
  submissions: [],
  protected: role === "server_admin",
  profiles: [],
  audit: [],
  rankings: [],
  personal: [],
});

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
    [notice, setNotice] = useState(""),
    [tab, setTab] = useState("Technical"),
    [technicalViewSlot, setTechnicalViewSlot] = useState(1),
    [performanceViewSlot, setPerformanceViewSlot] = useState(4),
    [selected, setSelected] = useState<string | null>(null),
    [theme, setTheme] = useState("light");
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
  const [newDivision, setNewDivision] = useState("");
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
    [newAdminTabPassword, setNewAdminTabPassword] = useState(""),
    [confirmAdminTabPassword, setConfirmAdminTabPassword] = useState(""),
    [adminTabPasswordMessage, setAdminTabPasswordMessage] = useState(""),
    [filter, setFilter] = useState("All divisions"),
    [competitorEdit, setCompetitorEdit] = useState<Partial<Competitor> | null>(
      null,
    ),
    [userEdit, setUserEdit] = useState<
      (Partial<Profile> & { username?: string; password?: string }) | null
    >(null);
  const state = workspace?.snapshot;
  const profile = state?.profile;
  const server = !!profile && canManage(profile);
  const organizer = profile?.role === "server_admin";
  const technical = (profile?.slot ?? 1) <= 3;
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
    (current.status === "active" || !!own);
  const allDivisions = Array.from(
    new Set([
      ...divisions,
      ...(state?.divisions ?? []),
      ...(state?.competitors.map((c) => c.division) ?? []),
    ]),
  );
  const changeThemePreference = (preference: "system" | "light" | "dark") => {
    setThemePreference(preference);
    localStorage.setItem("hidc-theme", preference);
    const effective = preference === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : preference;
    setTheme(effective);
    document.documentElement.dataset.theme = effective;
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
  const refresh = useCallback(async () => {
    if (demo || busy.current || ref.current?.queue.length || !navigator.onLine)
      return;
    busy.current = true;
    try {
      const snapshot: Snapshot = await api("state");
      chain.current = chain.current.then(async () => {
        if (!ref.current?.queue.length) await commit({ snapshot, queue: [] });
      });
      await chain.current;
    } catch (e) {
      setSyncError((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [commit]);
  const sync = useCallback(async () => {
    if (demo || busy.current || !navigator.onLine || !ref.current?.queue.length)
      return;
    busy.current = true;
    setSyncing(true);
    try {
      while (ref.current?.queue.length) {
        const entry = ref.current.queue[0];
        await api("sync", entry);
        chain.current = chain.current.then(async () => {
          if (ref.current)
            await commit({
              ...ref.current,
              queue: ref.current.queue.filter((o) => o.id !== entry.id),
            });
        });
        await chain.current;
      }
      const snapshot: Snapshot = await api("state");
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
  }, [commit]);
  useEffect(() => {
    // Light is the event-wide default; dark mode is an explicit console choice.
    const savedTheme = localStorage.getItem("hidc-theme");
    const preference = savedTheme === "dark" || savedTheme === "system" ? savedTheme : "light";
    setThemePreference(preference);
    const applyPreference = () => {
      const effective = preference === "system"
        ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : preference;
      setTheme(effective);
      document.documentElement.dataset.theme = effective;
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
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      if (themePreference !== "system") return;
      const effective = media.matches ? "dark" : "light";
      setTheme(effective);
      document.documentElement.dataset.theme = effective;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [themePreference]);
  useEffect(() => {
    if (!ready || !state) return;
    const timer = setInterval(() => {
      void sync();
      void refresh();
    }, 5000);
    void sync();
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
  }, [ready, state?.profile.id, online, sync, refresh]);
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
      title: "Remove this event?",
      body: `${event.trick} will be removed from the sequence. Its history remains in the audit log.`,
      action: () => persistAction("delete_event", { id: event.id }),
    });
  const finish = () =>
    setModal({
      title: "Finish this submission?",
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
    setSettingsOpen(true);
  }
  async function saveProfileSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!profile || !workspace) return;
    setProfileMessage("");
    setProfileMessageError(false);
    const usernameChanged = profileUsername.trim().toLowerCase() !== profile.username;
    if (
      (newLoginPassword || confirmLoginPassword) &&
      newLoginPassword !== confirmLoginPassword
    ) {
      setProfileMessage("The new passwords do not match.");
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
        await api("profile", payload);
        const snapshot: Snapshot = await api("state");
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
      const snapshot: Snapshot = await api("state");
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
      const snapshot: Snapshot = await api("state");
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
      await api("verify-admin", { password: adminPassword });
      setAdminUnlocked(true);
      setAdminPassword("");
    } catch (e) {
      setAdminPasswordError((e as Error).message);
    } finally {
      setAdminPasswordBusy(false);
    }
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
    } catch (e) {
      setSyncError((e as Error).message);
    }
  }
  async function switchDemo(value: string) {
    const role = value === "organizer" ? "server_admin" : "judge";
    const slot = role === "judge" ? Number(value) : 1;
    const snapshot = blankDemo(slot, role);
    const local = await readLocal(snapshot.profile.id);
    await commit(local ?? { snapshot, queue: [] });
    localStorage.setItem("hidc-demo-user", snapshot.profile.id);
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
          ...(technical ? {} : { Score: r.total }),
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
        <h2>Opening judge console</h2>
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
          <h1>Judge sign in</h1>
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
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button className="primary" disabled={loginBusy}>
              {loginBusy ? "Signing in…" : "Open judge console"}
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
    <div className="app-shell">
      <header>
        <button
          className="brand"
          title="Toggle light / dark theme"
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
                    : "Connected"}
          </span>
          <button
            className="profile-trigger"
            aria-label="Open profile and settings"
            title="Profile and settings"
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
            title="Sign out"
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
              if (name !== "Admin") setAdminUnlocked(false);
              if (name === "Admin") {
                setAdminUnlocked(false);
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
          <span>{syncError}</span>
          <button
            onClick={() => {
              setSyncError("");
              void sync();
            }}
          >
            Retry sync
          </button>
          <button
            onClick={() =>
              download(
                [{ workspace: JSON.stringify(workspace) }],
                "txt",
                "local-backup",
              )
            }
          >
            Download local backup
          </button>
          {workspace.queue.length > 0 && (
            <button
              onClick={() =>
                setModal({
                  title: "Reload the server copy?",
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
              Resolve conflict
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
                ? "Technical scoring"
                : tab === "Performance"
                  ? "Performance scoring"
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
                  Finish scoring <Check size={17} />
                </button>
              </div>
            </section>
            {tab === "Technical" ? (
              <div className="technical-layout">
                <aside className="sequence panel">
                  <div className="panel-heading">
                    <h3>
                      <PanelLeft size={16} /> Trick sequence
                    </h3>
                    <span className="count">
                      {displayed?.events.length ?? 0}
                    </span>
                  </div>
                  <div className="sequence-list">
                    {!displayed?.events.length ? (
                      <div className="empty-sequence">
                        <Layers size={28} />
                        <h4>No events yet</h4>
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
                    <span>
                      {state.protected
                        ? "Technical total"
                        : "Score values are protected"}
                    </span>
                    <b>{state.protected ? fmt(displayed?.total) : "•••"}</b>
                  </div>
                </aside>
                <div className="scoring-controls">
                  <section className="panel trick-panel">
                    <div className="panel-heading">
                      <h3>
                        01 <span>Select a trick</span>
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
                        <Flag size={15} /> Major deductions
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
                            {features.includes(f) && <Check size={13} />}
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
                      {editing ? "Update event" : "Record event"}
                      <kbd>↵</kbd>
                    </button>
                  </div>
                  <div className="scoring-foot">
                    <span>
                      <CheckCircle2 size={14} />{" "}
                      {demo
                        ? "Saved on this laptop"
                        : workspace.queue.length
                          ? `${workspace.queue.length} change(s) awaiting sync`
                          : "All changes synced"}
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
                          {(displayed?.performance[i] ?? 0).toFixed(1)}
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
                    {(
                      displayed?.performance.reduce((a, b) => a + b, 0) ?? 0
                    ).toFixed(1)}
                    <span>/ 30</span>
                  </div>
                  {categories.map((c, i) => (
                    <div className="summary-row" key={c}>
                      <span>{c}</span>
                      <b>{(displayed?.performance[i] ?? 0).toFixed(1)}</b>
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
                Full performance order <ArrowRight size={14} />
              </button>
            </section>
          </>
        )}
        {tab === "Saved Competitors" && (
          <section className="panel records">
            <div className="panel-heading">
              <h3>Performance order</h3>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option>All divisions</option>
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
                    <th>Your submission</th>
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
                <Trophy size={17} /> Your personal rankings
              </h3>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option>All divisions</option>
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
                        {!technical && <td>{fmt(r.total)}</td>}
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            {!state.personal?.length && (
              <div className="empty-state">
                <Trophy />
                <h3>No finished rankings yet</h3>
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
              <h3>Submission details</h3>
            </div>
            <div className="exports">
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
                      ),
                      format,
                      "score-details",
                    )
                  }
                >
                  <Download size={14} /> Export {format.toUpperCase()}
                </button>
              ))}
            </div>
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
                    {server ? ` · ${fmt(s.total)}` : ""}
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
                        {server && <span>{fmt(e.value)} points</span>}
                        <time>{new Date(e.at).toLocaleString()}</time>
                      </div>
                    ))
                  : categories.map((c, i) => (
                      <div className="detail-event" key={c}>
                        <span>{c}</span>
                        {server && <b>{s.performance[i].toFixed(1)}</b>}
                      </div>
                    ))}
              </details>
            ))}
            {!visibleSubmissions.length && (
              <div className="empty-state">No submissions yet.</div>
            )}
            {server && (
              <>
                <h3 className="audit-title">Audit history</h3>
                {!demo && !!state.audit?.length && (
                  <button
                    style={{ margin: 20 }}
                    onClick={async () => {
                      try {
                        const older = await api(
                          `audit?before=${state.audit![state.audit!.length - 1].id}`,
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
                {(state.audit ?? []).map((a, i) => (
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
                ))}
              </>
            )}
          </section>
        )}
        {tab === "Admin" && (
          !adminUnlocked ? (
            <section className="panel admin-password-panel">
              <div className="panel-heading">
                <h3>Admin access</h3>
              </div>
              <p>Enter the admin password to view score values.</p>
              <form onSubmit={verifyAdminPassword}>
                <label>
                  Admin password
                  <input
                    type="password"
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
                  {adminPasswordBusy ? "Checking…" : "Unlock admin tab"}
                  <ArrowRight size={16} />
                </button>
              </form>
            </section>
          ) : (
          <section className="panel records">
            <div className="panel-heading">
              <h3>Your score values</h3>
              <button
                onClick={() => {
                  setAdminUnlocked(false);
                  setAdminPassword("");
                  setAdminPasswordError("");
                }}
              >
                <Lock size={14} /> Lock Admin tab
              </button>
            </div>
            {exports((format, ranked) => {
              const ordered = [...personalSubmissions].sort((a, b) =>
                ranked
                  ? (b.total ?? total(b)) - (a.total ?? total(a))
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
                  <span>Total {fmt(s.total ?? total(s))}</span>
                </summary>
                {s.slot < 4
                  ? s.events.map((e, i) => (
                      <div className="detail-event" key={e.id}>
                        <span>
                          {i + 1}. {e.trick}
                        </span>
                        <b>{fmt(e.value ?? eventScore(e))} points</b>
                      </div>
                    ))
                  : categories.map((c, i) => (
                      <div className="detail-event" key={c}>
                        <span>{c}</span>
                        <b>{s.performance[i].toFixed(1)}</b>
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
                  <Radio size={17} /> Floor control
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
                      title: "End and lock this routine?",
                      body: "Judges can still correct their existing saved submissions. New entries require the routine to be active.",
                      action: () => void manage("lock", { id: active.id }),
                    })
                  }
                >
                  <Lock size={15} /> End routine
                </button>
                <button
                  className="primary"
                  disabled={
                    !state.competitors.some(
                      (c) => c.status === "upcoming" && !c.archived,
                    )
                  }
                  onClick={() => {
                    const next = state.competitors
                      .filter((c) => c.status === "upcoming" && !c.archived)
                      .sort((a, b) => a.position - b.position)[0];
                    if (next)
                      setModal({
                        title: `Activate ${next.name}?`,
                        body: "The current routine will be locked and all connected judges will see this competitor.",
                        action: () => void manage("activate", { id: next.id }),
                      });
                  }}
                >
                  Start next <ArrowRight size={16} />
                </button>
              </div>
            </section>
            <section className="panel records">
              <div className="panel-heading">
                <h3>Competitor roster</h3>
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
                  <Plus size={16} /> Add competitor
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
                                disabled={c.archived || c.status === "active"}
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
                  <Users size={16} /> Judge access
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
                  <Plus size={15} /> Create judge
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
                            : "Assign judge"}
                      </button>
                    </div>
                  );
                })}
              </div>
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
                      Edit account
                    </button>
                  </div>
                ))}
            </section>
            <section className="panel records admin-tab-password-panel">
              <div className="panel-heading">
                <h3>
                  <Shield size={17} /> Shared Admin-tab password
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
                  <input
                    type="password"
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
                  <input
                    type="password"
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
                  Update shared password <ArrowRight size={16} />
                </button>
              </form>
            </section>
            <section className="panel">
              <div className="panel-heading">
                <h3>Divisions</h3>
              </div>
              <form
                className="division-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void manage("division", { name: newDivision });
                  setNewDivision("");
                }}
              >
                <input
                  aria-label="New division name"
                  placeholder="New division name"
                  required
                  value={newDivision}
                  onChange={(e) => setNewDivision(e.target.value)}
                />
                <button disabled={demo}>
                  <Plus size={14} /> Add division
                </button>
              </form>
            </section>
            <section className="panel records">
              <div className="panel-heading">
                <h3>
                  <Trophy size={17} /> Global rankings
                </h3>
                <span className="muted">70 technical + 30 performance</span>
              </div>
              <div className="info-note">
                Exhibition is excluded. Incomplete submissions stay pending.
                Rankings remain provisional until all judges finish. DQ
                competitors rank last.
              </div>
              {exports((format, ranked) => {
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
                          {state.rankings
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
        <Dialog title="Profile & settings" close={() => setSettingsOpen(false)}>
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
              <input type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
            </label>
            <label>
              New password <span className="muted">(optional · minimum 6 characters)</span>
              <input type="password" minLength={6} maxLength={256} autoComplete="new-password" value={newLoginPassword} onChange={(e) => setNewLoginPassword(e.target.value)} />
            </label>
            <label>
              Confirm new password
              <input type="password" minLength={6} maxLength={256} autoComplete="new-password" value={confirmLoginPassword} onChange={(e) => setConfirmLoginPassword(e.target.value)} />
            </label>
            <p className="password-privacy-notice">Use a password only for this scoring system. Event organizers can reset account access; do not reuse a personal password.</p>
            <div className="profile-settings-actions">
              <button className="primary" disabled={profileBusy || (!online && !demo)}>
                {profileBusy ? "Saving…" : "Save profile"}
              </button>
            </div>
          </form>
          <div className="profile-local-settings">
            <label>
              Theme preference
              <select value={themePreference} onChange={(e) => changeThemePreference(e.target.value as "system" | "light" | "dark")}>
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
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
                    title: "Clear your offline cache?",
                    body: workspace?.queue.length
                      ? "Sync pending score changes first."
                      : "This removes only your local workspace from this browser and signs you out. It does not delete online profiles or scoring records.",
                    action: () => void clearOwnOfflineCache(),
                  });
                }}
              >Clear cache</button>
            </div>
            {workspace?.queue.length ? <p className="profile-help">Sync {workspace.queue.length} pending score change(s) before clearing your cache or signing out.</p> : null}
          </div>
          <div className="profile-dialog-footer">
            <button type="button" onClick={() => void signOut()}><LogOut size={15} /> Sign out</button>
          </div>
          {profileMessage && <p className={profileMessageError ? "error" : "success"} role="status">{profileMessage}</p>}
          {!online && !demo && <p className="profile-help">Profile, username, password, and picture changes require an online connection. Theme and hotkeys remain available offline.</p>}
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
              Reset defaults
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
          title={competitorEdit.id ? "Edit competitor" : "Add competitor"}
          close={() => setCompetitorEdit(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (competitorEdit.archived || competitorEdit.dq) {
                setModal({
                  title: "Confirm competitor status change?",
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
              <button className="primary">Save competitor</button>
            </div>
          </form>
        </Dialog>
      )}
      {userEdit && (
        <Dialog
          title={userEdit.id ? "Manage judge account" : "Create judge account"}
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
              <input
                type="password"
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
              <button className="primary">Save account</button>
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
