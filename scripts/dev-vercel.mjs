import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedAppKeys = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_BYPASS_AUTH",
];
const liveProjectRef = "msmdzuprjankfsgdozed";
const errors = [];

for (const key of allowedAppKeys) {
  if (!process.env[key]?.trim()) errors.push(`Missing required Vercel Development variable: ${key}`);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
let projectRef;
try {
  const parsed = new URL(supabaseUrl);
  if (parsed.protocol !== "https:" || parsed.hostname !== `${parsed.hostname.split(".")[0]}.supabase.co`) {
    errors.push("NEXT_PUBLIC_SUPABASE_URL must be an HTTPS Supabase project URL.");
  } else {
    projectRef = parsed.hostname.split(".")[0];
  }
} catch {
  if (supabaseUrl) errors.push("NEXT_PUBLIC_SUPABASE_URL must be a valid HTTPS Supabase project URL.");
}

if (process.env.NEXT_PUBLIC_BYPASS_AUTH?.trim() !== "false") {
  errors.push("NEXT_PUBLIC_BYPASS_AUTH must be exactly false for connected development.");
}

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
if (serviceKey.startsWith("eyJ")) {
  try {
    const payload = JSON.parse(Buffer.from(serviceKey.split(".")[1], "base64url").toString("utf8"));
    if (typeof payload.ref === "string" && projectRef && payload.ref !== projectRef) {
      errors.push("The Supabase service-role key does not match the configured development project URL.");
    }
  } catch {
    // Supabase is transitioning key formats; URL validation remains authoritative.
  }
}

// Next.js loads .env.local itself. Mask its variable names in the child environment
// so that unset Vercel variables cannot silently fall back to a local file.
const maskedFileKeys = new Set();
for (const file of readdirSync(root).filter((name) => name.startsWith(".env"))) {
  try {
    const contents = readFileSync(path.join(root, file), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match && !allowedAppKeys.includes(match[1])) maskedFileKeys.add(match[1]);
    }
  } catch {
    errors.push("Could not safely inspect local environment-file variable names.");
  }
}

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else if (process.argv.includes("--check")) {
  if (projectRef === liveProjectRef) console.warn("Development is connected to the live HIDC database. Scoring and admin actions will affect production data.");
  console.log("Vercel Development environment checks passed. No variable values were displayed.");
} else {
  if (projectRef === liveProjectRef) console.warn("Connected to the live HIDC database. Scoring and admin actions will affect production data.");
  const childEnv = {};
  const inheritedKeys = [
    "PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
    "HOME", "CI", "TERM", "FORCE_COLOR",
  ];
  for (const key of inheritedKeys) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }
  for (const key of allowedAppKeys) childEnv[key] = process.env[key];
  for (const key of maskedFileKeys) childEnv[key] = "";
  childEnv.NODE_ENV = "development";

  const windows = process.platform === "win32";
  const result = spawnSync(windows ? "npm.cmd" : "npm", ["run", "dev"], {
    cwd: root,
    env: childEnv,
    stdio: "inherit",
    shell: windows,
  });
  if (result.error) {
    console.error("Could not start the local development server.");
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
