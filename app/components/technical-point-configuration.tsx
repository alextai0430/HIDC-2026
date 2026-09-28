"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Save, SlidersHorizontal } from "lucide-react";
import { api } from "@/lib/supabase";
import { deductions, tricks } from "@/lib/model";
import type { ScoringConfiguration, ScoringRules } from "@/lib/model";
import type { ScoringConfigurationImpact } from "@/lib/scoring-config";

const confirmPhrase = "UPDATE POINT VALUES";
const levelKeys = ["0.5", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
const featureKeys = ["T1", "T2", "T3", "A"] as const;

type RuleDraft = {
  bases: Record<string, Record<string, string>>;
  deductions: Record<string, string>;
  levels: Record<string, string>;
  features: Record<string, string>;
};
type Preview = {
  revision: number;
  dataRevision: number;
  impact: ScoringConfigurationImpact;
  unchanged: boolean;
};
type Props = {
  adminUnlockToken: string;
  queuedActions: number;
  oldestQueuedRevision?: number;
  onSaved: (revision: number) => void | Promise<void>;
};

function toDraft(rules: ScoringRules): RuleDraft {
  const convert = (items: Record<string, number>) =>
    Object.fromEntries(Object.entries(items).map(([key, value]) => [key, String(value)]));
  return {
    bases: Object.fromEntries(Object.entries(rules.bases).map(([category, values]) => [category, convert(values)])),
    deductions: convert(rules.deductions),
    levels: convert(rules.levels),
    features: convert(rules.features),
  };
}

function parseDraft(draft: RuleDraft): ScoringRules {
  const convert = (items: Record<string, string>) =>
    Object.fromEntries(Object.entries(items).map(([key, value]) => [key, value.trim() === "" ? Number.NaN : Number(value)]));
  return {
    bases: Object.fromEntries(Object.entries(draft.bases).map(([category, values]) => [category, convert(values)])),
    deductions: convert(draft.deductions),
    levels: convert(draft.levels),
    features: convert(draft.features),
  };
}

function validateDraft(rules: ScoringRules) {
  const values = [
    ...Object.values(rules.bases).flatMap(Object.values),
    ...Object.values(rules.deductions),
    ...Object.values(rules.levels),
    ...Object.values(rules.features),
  ];
  if (values.some((value) => !Number.isFinite(value))) return "Enter a number for every point value.";
  if (Object.values(rules.bases).some((group) => Object.values(group).some((value) => value < 0 || value > 1000))) {
    return "Base values must be between 0 and 1,000.";
  }
  if (Object.values(rules.deductions).some((value) => value < -1000 || value > 0)) {
    return "Deduction values must be between −1,000 and 0.";
  }
  if ([...Object.values(rules.levels), ...Object.values(rules.features)].some((value) => value < 0.01 || value > 100)) {
    return "Level and feature multipliers must be between 0.01 and 100.";
  }
  return "";
}

export default function TechnicalPointConfiguration({
  adminUnlockToken,
  queuedActions,
  oldestQueuedRevision,
  onSaved,
}: Props) {
  const [revision, setRevision] = useState<number | null>(null);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [savedDraft, setSavedDraft] = useState<RuleDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api("scoring-configuration", undefined, { adminUnlockToken })
      .then((configuration: ScoringConfiguration) => {
        if (!active) return;
        const nextDraft = toDraft(configuration.rules);
        setRevision(configuration.revision);
        setDraft(nextDraft);
        setSavedDraft(nextDraft);
      })
      .catch((cause: Error) => {
        if (active) setError(cause.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [adminUnlockToken]);

  const setValue = (group: "bases" | "deductions" | "levels" | "features", key: string, value: string, category?: string) => {
    setDraft((current) => {
      if (!current) return current;
      if (group === "bases" && category) {
        return { ...current, bases: { ...current.bases, [category]: { ...current.bases[category], [key]: value } } };
      }
      return { ...current, [group]: { ...current[group], [key]: value } };
    });
    setMessage("");
  };

  const cancelConfirmation = () => {
    setPreview(null);
    setConfirmation("");
  };

  const save = async () => {
    if (!draft || revision === null || busy) return;
    setError("");
    setMessage("");
    const rules = parseDraft(draft);
    const invalid = validateDraft(rules);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    try {
      const nextPreview: Preview = await api("scoring-configuration", {
        action: "preview",
        expectedRevision: revision,
        rules,
      }, { adminUnlockToken });
      if (nextPreview.unchanged) {
        setMessage("No point values changed.");
        return;
      }
      setPreview(nextPreview);
      setConfirmation("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirmUpdate = async () => {
    if (!draft || !preview || confirmation !== confirmPhrase || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api("scoring-configuration", {
        action: "update",
        expectedRevision: preview.revision,
        expectedDataRevision: preview.dataRevision,
        rules: parseDraft(draft),
        impact: preview.impact,
        confirmation: confirmPhrase,
      }, { adminUnlockToken });
      const nextDraft = toDraft(result.rules);
      setRevision(result.revision);
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      setPreview(null);
      setConfirmation("");
      setMessage(`Configuration v${result.revision} saved. Scores and rankings now use the updated rules.`);
      if (queuedActions > 0 && oldestQueuedRevision !== undefined && oldestQueuedRevision < result.revision) {
        setMessage(`Configuration v${result.revision} saved. ${queuedActions} queued offline change${queuedActions === 1 ? "" : "s"} will use the current rules when synced.`);
      } else if (queuedActions > 0) {
        setMessage(`Configuration v${result.revision} saved. Any judges with queued offline scores will use the current rules when they sync.`);
      } else {
        setMessage(`Configuration v${result.revision} saved. Any judges with queued offline scores will use these rules when they sync.`);
      }
      await onSaved(result.revision);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dirty = !!draft && !!savedDraft && JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const staleQueue = queuedActions > 0 && revision !== null && oldestQueuedRevision !== undefined && oldestQueuedRevision < revision;

  return (
    <section className="panel records technical-point-config" aria-labelledby="technical-point-config-heading">
      <div className="panel-heading">
        <h3 id="technical-point-config-heading"><SlidersHorizontal size={16} /> Technical Point Configuration</h3>
        {revision !== null ? <span className="muted">Revision {revision}</span> : null}
      </div>
      <p className="point-config-subtitle">Global scoring rules</p>
      {loading ? <p className="muted point-config-state">Loading point values…</p> : null}
      {error ? <p className="error point-config-state" role="alert">{error}</p> : null}
      {message ? <p className="success point-config-state" role="status">{message}</p> : null}
      {staleQueue ? (
        <p className="point-config-offline-note" role="status">
          {queuedActions} pending offline change{queuedActions === 1 ? "" : "s"}; these selections will be scored with the current configuration when synced.
        </p>
      ) : null}
      {!loading && !error && draft ? (
        <>
          <div className="point-config-base-grid">
            {Object.entries(tricks).map(([category, dimensions]) => (
              <fieldset key={category} className="point-config-group" data-category={category}>
                <legend>{category === "#" ? "# · Toss" : category}</legend>
                <div className="point-config-fields">
                  {dimensions.map((dimension) => (
                    <label key={dimension}>
                      <span>{category} · {dimension}</span>
                      <input
                        type="number"
                        min="0"
                        max="1000"
                        step="0.1"
                        value={draft.bases[category]?.[dimension] ?? ""}
                        onChange={(event) => setValue("bases", dimension, event.target.value, category)}
                        aria-label={`${category} ${dimension} base points`}
                        disabled={loading || busy}
                      />
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          <div className="point-config-advanced">
            <details open data-category="deduction">
              <summary>Deduction Values</summary>
              <div className="point-config-fields" data-category="deduction">
                {deductions.map((deduction) => (
                  <label key={deduction}>
                    <span>{deduction}</span>
                    <input type="number" min="-1000" max="0" step="0.1" value={draft.deductions[deduction] ?? ""} onChange={(event) => setValue("deductions", deduction, event.target.value)} aria-label={`${deduction} value`} disabled={busy} />
                  </label>
                ))}
              </div>
            </details>
            <details data-category="level">
              <summary>Level Multipliers</summary>
              <div className="point-config-fields" data-category="level">
                {levelKeys.map((level) => (
                  <label key={level}>
                    <span>Level {level}</span>
                    <input type="number" min="0.01" max="100" step="0.1" value={draft.levels[level] ?? ""} onChange={(event) => setValue("levels", level, event.target.value)} aria-label={`Level ${level} multiplier`} disabled={busy} />
                  </label>
                ))}
              </div>
            </details>
            <details data-category="feature">
              <summary>Feature Multipliers</summary>
              <div className="point-config-fields" data-category="feature">
                {featureKeys.map((feature) => (
                  <label key={feature}>
                    <span>{feature}</span>
                    <input type="number" min="0.01" max="100" step="0.1" value={draft.features[feature] ?? ""} onChange={(event) => setValue("features", feature, event.target.value)} aria-label={`${feature} multiplier`} disabled={busy} />
                  </label>
                ))}
              </div>
            </details>
          </div>
          <div className="point-config-actions">
            <button className="primary" type="button" disabled={!dirty || busy} onClick={() => void save()}>
              <Save size={15} /> {busy ? "Preparing…" : "Save changes"}
            </button>
          </div>
        </>
      ) : null}
      {preview ? (
        <div className="point-config-dialog-backdrop">
          <section className="point-config-dialog" role="alertdialog" aria-modal="true" aria-labelledby="point-config-warning-title" aria-describedby="point-config-warning-copy">
            <div className="point-config-warning-heading">
              <AlertTriangle size={22} />
              <h4 id="point-config-warning-title">Update Global Scoring Rules?</h4>
            </div>
            <p id="point-config-warning-copy" className="point-config-high-risk-warning">
              Changing technical point values recalculates every affected score, including finished competitors and finalized rankings. This may change official placements and exports.
            </p>
            <dl className="point-config-impact">
              <div><dt>Technical submissions affected</dt><dd>{preview.impact.technicalSubmissions}</dd></div>
              <div><dt>Event values recalculated</dt><dd>{preview.impact.technicalEventValues}</dd></div>
              <div><dt>Competitors affected</dt><dd>{preview.impact.competitors}</dd></div>
              <div><dt>Ranked divisions affected</dt><dd>{preview.impact.rankingDivisions}</dd></div>
              <div><dt>Finalized rankings recalculated</dt><dd>{preview.impact.finalizedRankings}</dd></div>
            </dl>
            <label className="point-config-confirmation">
              Type <code>{confirmPhrase}</code> to confirm
              <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} aria-label={`Type ${confirmPhrase} to confirm`} />
            </label>
            {error ? <p className="error" role="alert">{error}</p> : null}
            <div className="point-config-dialog-actions">
              <button type="button" onClick={cancelConfirmation} disabled={busy}>Cancel</button>
              <button type="button" className="danger-button" disabled={busy || confirmation !== confirmPhrase} onClick={() => void confirmUpdate()}>
                {busy ? "Updating…" : "Confirm Update"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
