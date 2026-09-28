"use client";

import { useEffect, useRef, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import {
  AppearancePreferences,
  appearanceFonts,
  appearanceSchemes,
  appearanceTemplates,
  defaultAppearance,
} from "@/lib/appearance";

export type AppearanceSaveResult = {
  preferences: AppearancePreferences;
  updatedAt: string;
  saved: boolean;
  conflict: boolean;
  offline: boolean;
};

export default function AppearanceSettings({
  initial,
  online,
  demo = false,
  onPreview,
  onSave,
}: {
  initial: AppearancePreferences;
  online: boolean;
  demo?: boolean;
  onPreview: (preferences: AppearancePreferences) => void;
  onSave: (preferences: AppearancePreferences) => Promise<AppearanceSaveResult>;
}) {
  const [draft, setDraft] = useState(initial);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const savedRef = useRef(false);
  const savedPreferencesRef = useRef(initial);

  useEffect(() => {
    onPreview(draft);
  }, [draft, onPreview]);

  useEffect(() => () => {
    if (!savedRef.current) onPreview(savedPreferencesRef.current);
  }, [onPreview]);

  function update(next: Partial<AppearancePreferences>) {
    savedRef.current = false;
    setMessage("");
    setError(false);
    setDraft((current) => ({ ...current, ...next }));
  }

  async function save() {
    setBusy(true);
    setMessage("");
    setError(false);
    try {
      const result = await onSave(draft);
      savedPreferencesRef.current = result.preferences;
      if (result.conflict) {
        setDraft(result.preferences);
        setMessage("A newer appearance saved on another device was kept.");
      } else if (result.offline) {
        setMessage(demo ? "Saved to this demo workspace on this laptop." : "Saved on this laptop. It will sync when connected.");
      } else {
        setMessage("Appearance saved to your profile.");
      }
      savedRef.current = true;
    } catch (reason) {
      setError(true);
      setMessage(reason instanceof Error ? reason.message : "Appearance could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  function cancelPreview() {
    setDraft(savedPreferencesRef.current);
    onPreview(savedPreferencesRef.current);
    setMessage("Preview canceled.");
    setError(false);
    savedRef.current = true;
  }

  const selectedFont = appearanceFonts.find((font) => font.id === draft.font)!;
  return (
    <section className="appearance-settings" aria-labelledby="appearance-heading">
      <div className="appearance-heading">
        <div>
          <h3 id="appearance-heading">Appearance</h3>
          <p>Changes preview immediately and apply only to your account.</p>
        </div>
        <button type="button" className="appearance-reset" onClick={() => setResetConfirm(true)}>
          <RotateCcw size={14} /> Reset to Default
        </button>
      </div>

      {resetConfirm ? (
        <div className="appearance-reset-confirm" role="alertdialog" aria-labelledby="appearance-reset-title">
          <span id="appearance-reset-title">Reset the preview to the default layout, colors, font, and theme?</span>
          <button type="button" autoFocus onClick={() => setResetConfirm(false)}>Cancel</button>
          <button type="button" className="primary" onClick={() => { update(defaultAppearance); setResetConfirm(false); }}>Reset Appearance</button>
        </div>
      ) : null}

      <fieldset className="appearance-choice-group">
        <legend>Layout</legend>
        <div className="appearance-template-grid">
          {appearanceTemplates.map((template) => (
            <button
              type="button"
              key={template.id}
              className={`appearance-template-option ${draft.template === template.id ? "selected" : ""}`}
              aria-pressed={draft.template === template.id}
              onClick={() => update({ template: template.id })}
            >
              <span className={`template-miniature ${template.id}`} aria-hidden="true">
                <i /><i /><i /><i />
              </span>
              <span>{template.label}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="appearance-choice-group">
        <legend>Color Scheme</legend>
        <div className="appearance-scheme-grid">
          {appearanceSchemes.map((scheme) => (
            <button
              type="button"
              key={scheme.id}
              className={`appearance-scheme-option ${draft.scheme === scheme.id ? "selected" : ""}`}
              aria-pressed={draft.scheme === scheme.id}
              onClick={() => update({ scheme: scheme.id })}
            >
              <span className="scheme-swatches" aria-hidden="true">
                <i style={{ backgroundColor: scheme.accent }} />
                <i style={{ backgroundColor: scheme.darkAccent }} />
                <i style={{ backgroundColor: scheme.hue === 220 && scheme.saturation === 0 ? "#7d8793" : `hsl(${scheme.hue} ${Math.min(scheme.saturation, 30)}% 88%)` }} />
              </span>
              <span>{scheme.label}</span>
              {draft.scheme === scheme.id ? <Check size={13} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="appearance-select-row">
        <label>
          Font
          <select value={draft.font} onChange={(event) => update({ font: event.target.value as AppearancePreferences["font"] })}>
            {appearanceFonts.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}
          </select>
        </label>
        <label>
          Theme
          <select value={draft.mode} onChange={(event) => update({ mode: event.target.value as AppearancePreferences["mode"] })}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </div>

      <div className="appearance-preview" aria-label="Live appearance preview">
        <div className="appearance-preview-topline"><span>HIDC 2026</span><span>{selectedFont.label}</span></div>
        <p style={{ fontFamily: selectedFont.css }}>Clear scores, readable controls, confident judging.</p>
        <div className="appearance-preview-controls">
          <span className="category-preview gold"># · 2D</span>
          <span className="category-preview green">T · 1D</span>
          <span className="category-preview blue">O · 2D</span>
          <span className="category-preview selected-preview">Selected 3D</span>
          <span className="appearance-preview-status"><i /> Synced</span>
        </div>
      </div>

      <div className="appearance-actions">
        {message ? <p className={error ? "error" : "appearance-feedback"} role="status">{message}</p> : null}
        <button type="button" onClick={cancelPreview} disabled={busy}>Cancel</button>
        <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : demo ? "Save Locally" : online ? "Save Appearance" : "Save Offline"}
        </button>
      </div>
    </section>
  );
}
