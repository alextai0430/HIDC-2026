export const appearanceTemplates = [
  { id: "control-room", label: "Control Room" },
  { id: "classic-panel", label: "Classic Panel" },
  { id: "focus-mode", label: "Focus Mode" },
  { id: "sidebar-workspace", label: "Sidebar Workspace" },
  { id: "minimal-scoreboard", label: "Minimal Scoreboard" },
] as const;

type AppearanceScheme = { id: string; label: string; hue: number; saturation: number; accent: string; darkAccent: string; contrast?: boolean };
export const appearanceSchemes = [
  { id: "hidc-navy", label: "HIDC Navy", hue: 211, saturation: 34, accent: "#087c83", darkAccent: "#69dfd0" },
  { id: "midnight-teal", label: "Midnight Teal", hue: 174, saturation: 35, accent: "#087b72", darkAccent: "#57d5c4" },
  { id: "slate", label: "Slate", hue: 215, saturation: 12, accent: "#496f95", darkAccent: "#8bbcf1" },
  { id: "graphite", label: "Graphite", hue: 220, saturation: 7, accent: "#56616f", darkAccent: "#c0cad6" },
  { id: "ocean-blue", label: "Ocean Blue", hue: 205, saturation: 40, accent: "#176db0", darkAccent: "#72bdff" },
  { id: "forest", label: "Forest", hue: 145, saturation: 25, accent: "#267444", darkAccent: "#7ee1a0" },
  { id: "emerald", label: "Emerald", hue: 158, saturation: 39, accent: "#08794f", darkAccent: "#53e2a2" },
  { id: "violet", label: "Violet", hue: 270, saturation: 29, accent: "#7040aa", darkAccent: "#c19aff" },
  { id: "indigo", label: "Indigo", hue: 237, saturation: 31, accent: "#4955b5", darkAccent: "#a1a9ff" },
  { id: "crimson", label: "Crimson", hue: 350, saturation: 25, accent: "#a6384d", darkAccent: "#ff91a4" },
  { id: "sunset", label: "Sunset", hue: 20, saturation: 36, accent: "#b85825", darkAccent: "#ffac78" },
  { id: "amber", label: "Amber", hue: 40, saturation: 34, accent: "#8b6500", darkAccent: "#f2c75a" },
  { id: "rose", label: "Rose", hue: 337, saturation: 27, accent: "#aa3c70", darkAccent: "#ff96c5" },
  { id: "lavender", label: "Lavender", hue: 283, saturation: 24, accent: "#784e96", darkAccent: "#d3a6f4" },
  { id: "arctic", label: "Arctic", hue: 193, saturation: 32, accent: "#167b91", darkAccent: "#77ddf1" },
  { id: "sand", label: "Sand", hue: 38, saturation: 24, accent: "#80602c", darkAccent: "#e4c58c" },
  { id: "espresso", label: "Espresso", hue: 26, saturation: 25, accent: "#815035", darkAccent: "#d6a784" },
  { id: "monochrome", label: "Monochrome", hue: 220, saturation: 0, accent: "#4b5563", darkAccent: "#d5dbe3" },
  { id: "high-contrast-dark", label: "High Contrast Dark", hue: 220, saturation: 0, accent: "#005d52", darkAccent: "#77e8d3", contrast: true },
  { id: "high-contrast-light", label: "High Contrast Light", hue: 220, saturation: 0, accent: "#005d52", darkAccent: "#76f0db", contrast: true },
] as const;

type AppearanceFont = { id: string; label: string; css: string; google?: string };
export const appearanceFonts = [
  { id: "inter", label: "Inter", css: 'Inter, "Segoe UI", Arial, sans-serif', google: "Inter:wght@400;500;600;700;800" },
  { id: "geist", label: "Geist", css: 'Geist, "Segoe UI", Arial, sans-serif', google: "Geist:wght@400;500;600;700;800" },
  { id: "atkinson-hyperlegible", label: "Atkinson Hyperlegible", css: '"Atkinson Hyperlegible", "Segoe UI", Arial, sans-serif', google: "Atkinson+Hyperlegible:wght@400;700" },
  { id: "source-sans-3", label: "Source Sans 3", css: '"Source Sans 3", "Segoe UI", Arial, sans-serif', google: "Source+Sans+3:wght@400;500;600;700;800" },
  { id: "ibm-plex-sans", label: "IBM Plex Sans", css: '"IBM Plex Sans", "Segoe UI", Arial, sans-serif', google: "IBM+Plex+Sans:wght@400;500;600;700" },
  { id: "nunito-sans", label: "Nunito Sans", css: '"Nunito Sans", "Segoe UI", Arial, sans-serif', google: "Nunito+Sans:wght@400;500;600;700;800" },
  { id: "manrope", label: "Manrope", css: 'Manrope, "Segoe UI", Arial, sans-serif', google: "Manrope:wght@400;500;600;700;800" },
  { id: "work-sans", label: "Work Sans", css: '"Work Sans", "Segoe UI", Arial, sans-serif', google: "Work+Sans:wght@400;500;600;700;800" },
  { id: "lato", label: "Lato", css: 'Lato, "Segoe UI", Arial, sans-serif', google: "Lato:wght@400;700;900" },
  { id: "system-ui", label: "System UI", css: 'system-ui, "Segoe UI", Arial, sans-serif' },
] as const;

export type AppearancePreferences = {
  template: (typeof appearanceTemplates)[number]["id"];
  scheme: (typeof appearanceSchemes)[number]["id"];
  font: (typeof appearanceFonts)[number]["id"];
  mode: "system" | "light" | "dark";
};

export const defaultAppearance: AppearancePreferences = {
  template: "control-room",
  scheme: "hidc-navy",
  font: "system-ui",
  mode: "light",
};

export type AppearanceTokens = Record<"--bg" | "--panel" | "--panel2" | "--border" | "--text" | "--muted" | "--teal" | "--teal-bg" | "--action-bg" | "--action-border" | "--action-text" | "--action-hover" | "--action-hover-border" | "--danger" | "--danger-bg" | "--field-bg" | "--field-border", string>;

const hsl = (hue: number, saturation: number, lightness: number) =>
  `hsl(${hue} ${saturation}% ${lightness}%)`;

export function appearanceTokens(schemeId: AppearancePreferences["scheme"], mode: "light" | "dark"): AppearanceTokens {
  const palette = (appearanceSchemes.find(({ id }) => id === schemeId) ?? appearanceSchemes[0]) as AppearanceScheme;
  const dark = mode === "dark";
  const hue = palette.hue;
  const sat = palette.saturation;
  const accent = dark ? palette.darkAccent : palette.accent;
  const highContrast = palette.contrast;
  const bg = highContrast
    ? dark ? "#000000" : "#ffffff"
    : hsl(hue, Math.min(sat, 32), dark ? 6 : 97);
  const panel = highContrast
    ? dark ? "#050505" : "#ffffff"
    : hsl(hue, Math.min(sat, 28), dark ? 11 : 100);
  const panel2 = highContrast
    ? dark ? "#101010" : "#f1f1f1"
    : hsl(hue, Math.min(sat, 26), dark ? 16 : 94);
  const border = highContrast
    ? dark ? "#a8a8a8" : "#252525"
    : hsl(hue, Math.min(sat, 20), dark ? 27 : 82);
  return {
    "--bg": bg,
    "--panel": panel,
    "--panel2": panel2,
    "--border": border,
    "--text": dark ? "#f5f7fa" : "#172331",
    "--muted": dark ? "#b2bfcc" : "#526272",
    "--teal": accent,
    "--teal-bg": dark ? `color-mix(in srgb, ${accent} 19%, ${panel})` : `color-mix(in srgb, ${accent} 13%, ${panel})`,
    "--action-bg": dark ? accent : `color-mix(in srgb, ${accent} 24%, white)`,
    "--action-border": dark ? accent : `color-mix(in srgb, ${accent} 56%, white)`,
    "--action-text": dark ? "#081511" : "#14242a",
    "--action-hover": dark ? `color-mix(in srgb, ${accent} 82%, white)` : `color-mix(in srgb, ${accent} 33%, white)`,
    "--action-hover-border": dark ? accent : `color-mix(in srgb, ${accent} 72%, white)`,
    "--danger": dark ? "#ff9fa5" : "#9f1f30",
    "--danger-bg": dark ? "#3a2027" : "#fff0f2",
    "--field-bg": panel2,
    "--field-border": border,
  };
}

export function applyAppearance(preferences: AppearancePreferences, effectiveMode?: "light" | "dark") {
  if (typeof document === "undefined") return;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const mode = effectiveMode ?? (preferences.mode === "system" ? media.matches ? "dark" : "light" : preferences.mode);
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.dataset.appearanceTemplate = preferences.template;
  root.dataset.appearanceScheme = preferences.scheme;
  root.dataset.appearanceFont = preferences.font;
  for (const [name, value] of Object.entries(appearanceTokens(preferences.scheme, mode)))
    root.style.setProperty(name, value);
  const selectedFont = (appearanceFonts.find(({ id }) => id === preferences.font) ?? appearanceFonts[appearanceFonts.length - 1]) as AppearanceFont;
  root.style.setProperty("--app-font", selectedFont.css);
  if (selectedFont.google && typeof document !== "undefined" && navigator.onLine) {
    const linkId = `hidc-font-${selectedFont.id}`;
    if (!document.getElementById(linkId)) {
      const link = document.createElement("link");
      link.id = linkId;
      link.rel = "stylesheet";
      link.href = `https://fonts.googleapis.com/css2?family=${selectedFont.google.replaceAll(" ", "+")}&display=swap`;
      document.head.append(link);
    }
  }
}

export function isAppearancePreferences(value: unknown): value is AppearancePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).sort().join(",") === "font,mode,scheme,template" &&
    appearanceTemplates.some(({ id }) => id === candidate.template) &&
    appearanceSchemes.some(({ id }) => id === candidate.scheme) &&
    appearanceFonts.some(({ id }) => id === candidate.font) &&
    ["system", "light", "dark"].includes(candidate.mode as string);
}
