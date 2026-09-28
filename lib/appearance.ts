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
  { id: "neon-arcade", label: "Neon Arcade", hue: 305, saturation: 78, accent: "#9800a8", darkAccent: "#ff64f0" },
  { id: "cyberpunk", label: "Cyberpunk", hue: 326, saturation: 72, accent: "#a00046", darkAccent: "#ff579c" },
  { id: "retro-terminal", label: "Retro Terminal", hue: 132, saturation: 66, accent: "#08742b", darkAccent: "#78ff9a" },
  { id: "synthwave", label: "Synthwave", hue: 292, saturation: 69, accent: "#7133a6", darkAccent: "#d986ff" },
  { id: "vaporwave", label: "Vaporwave", hue: 187, saturation: 68, accent: "#00798a", darkAccent: "#60f0ff" },
  { id: "deep-space", label: "Deep Space", hue: 245, saturation: 54, accent: "#34359b", darkAccent: "#9597ff" },
  { id: "aurora", label: "Aurora", hue: 160, saturation: 62, accent: "#067153", darkAccent: "#56ffc0" },
  { id: "solar-flare", label: "Solar Flare", hue: 24, saturation: 72, accent: "#b13f0b", darkAccent: "#ff9b4d" },
  { id: "cherry-blossom", label: "Cherry Blossom", hue: 337, saturation: 53, accent: "#a52f70", darkAccent: "#ff9dd0" },
  { id: "tropical", label: "Tropical", hue: 168, saturation: 66, accent: "#007e78", darkAccent: "#54fff0" },
  { id: "midnight-purple", label: "Midnight Purple", hue: 264, saturation: 59, accent: "#5b37a0", darkAccent: "#bd9aff" },
  { id: "electric-lime", label: "Electric Lime", hue: 82, saturation: 68, accent: "#4b7100", darkAccent: "#d0ff62" },
  { id: "candy-pop", label: "Candy Pop", hue: 326, saturation: 57, accent: "#aa286f", darkAccent: "#ff85c7" },
  { id: "royal-gold", label: "Royal Gold", hue: 46, saturation: 62, accent: "#846000", darkAccent: "#f6d35f" },
  { id: "paper-notebook", label: "Paper Notebook", hue: 44, saturation: 35, accent: "#725a2d", darkAccent: "#dec38f" },
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
  { id: "times-new-roman", label: "Times New Roman (Serif)", css: '"Times New Roman", Times, serif' },
  { id: "georgia", label: "Georgia (Serif)", css: 'Georgia, "Times New Roman", serif' },
  { id: "garamond", label: "Garamond (Serif)", css: 'Garamond, "Adobe Garamond Pro", "Times New Roman", serif' },
  { id: "courier-new", label: "Courier New (Monospace)", css: '"Courier New", Courier, monospace' },
  { id: "trebuchet-ms", label: "Trebuchet MS", css: '"Trebuchet MS", "Segoe UI", sans-serif' },
  { id: "comic-sans-ms", label: "Comic Sans MS (Playful)", css: '"Comic Sans MS", "Comic Sans", cursive' },
  { id: "verdana", label: "Verdana", css: 'Verdana, Geneva, sans-serif' },
  { id: "palatino", label: "Palatino (Serif)", css: '"Palatino Linotype", Palatino, "Book Antiqua", serif' },
  { id: "bookman", label: "Bookman (Serif)", css: '"Bookman Old Style", Bookman, "URW Bookman", serif' },
  { id: "rounded-quicksand", label: "Rounded (Quicksand)", css: 'Quicksand, "Arial Rounded MT Bold", "Segoe UI", sans-serif', google: "Quicksand:wght@400;500;600;700" },
] as const;

export type AppearancePreferences = {
  template: (typeof appearanceTemplates)[number]["id"];
  scheme: (typeof appearanceSchemes)[number]["id"];
  font: (typeof appearanceFonts)[number]["id"];
  mode: "system" | "light" | "dark";
  sidebarCollapsed: boolean;
};

export const defaultAppearance: AppearancePreferences = {
  template: "control-room",
  scheme: "hidc-navy",
  font: "system-ui",
  mode: "light",
  sidebarCollapsed: false,
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
    ? dark ? palette.id === "high-contrast-light" ? "#0a0a0a" : "#000000" : "#ffffff"
    : palette.id === "hidc-navy" && dark
      ? "#000000"
    : hsl(hue, Math.min(sat, 82), dark ? 7 : 93);
  const panel = highContrast
    ? dark ? palette.id === "high-contrast-light" ? "#161616" : "#050505" : "#ffffff"
    : hsl(hue, Math.min(sat, 82), dark ? 13 : 98);
  const panel2 = highContrast
    ? dark ? palette.id === "high-contrast-light" ? "#252525" : "#101010" : "#f1f1f1"
    : hsl(hue, Math.min(sat, 82), dark ? 21 : 87);
  const border = highContrast
    ? dark ? palette.id === "high-contrast-light" ? "#c2c2c2" : "#a8a8a8" : "#252525"
    : hsl(hue, Math.min(sat, 62), dark ? 36 : 68);
  return {
    "--bg": bg,
    "--panel": panel,
    "--panel2": panel2,
    "--border": border,
    "--text": dark ? "#f5f7fa" : "#172331",
    "--muted": dark ? "#d1dbe5" : "#405060",
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
  root.dataset.appearanceSidebarCollapsed = String(preferences.sidebarCollapsed);
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
  const keys = Object.keys(candidate).sort().join(",");
  return (keys === "font,mode,scheme,template" || keys === "font,mode,scheme,sidebarCollapsed,template") &&
    (candidate.sidebarCollapsed === undefined || typeof candidate.sidebarCollapsed === "boolean") &&
    appearanceTemplates.some(({ id }) => id === candidate.template) &&
    appearanceSchemes.some(({ id }) => id === candidate.scheme) &&
    appearanceFonts.some(({ id }) => id === candidate.font) &&
    ["system", "light", "dark"].includes(candidate.mode as string);
}

export function normalizeAppearancePreferences(value: unknown): AppearancePreferences {
  if (!isAppearancePreferences(value)) return defaultAppearance;
  return {
    template: value.template,
    scheme: value.scheme,
    font: value.font,
    mode: value.mode,
    sidebarCollapsed: value.sidebarCollapsed ?? false,
  };
}
