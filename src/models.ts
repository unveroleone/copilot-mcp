import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CustomModel {
  name: string;
  description?: string;
  // Env vars injected into the spawned copilot process for this model
  // (Copilot BYOK provider configuration).
  env: Record<string, string>;
}

const MODELS_FILE = join(homedir(), ".copilot-mcp", "models.json");

// Static fallback catalog, used when the installed Copilot bundle cannot be read.
const FALLBACK_BUILT_IN_MODELS = [
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.7-high",
  "claude-opus-4.7-xhigh",
  "claude-opus-4.6",
  "claude-opus-4.6-fast",
  "claude-opus-4.6-1m",
  "claude-opus-4.5",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.4-mini",
  "gpt-5-mini",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
];

export function resolveCopilotBinary(): string | null {
  const res = spawnSync("which", ["copilot"], { encoding: "utf8" });
  const found = res.stdout?.trim();
  return found || null;
}

/**
 * Extracts the built-in model catalog from the installed Copilot CLI bundle.
 * The catalog is the TF=[...] array in app.js; model resolution validates
 * against it, so it reflects exactly what this CLI version accepts.
 */
export function extractBuiltInModels(): string[] {
  const bin = resolveCopilotBinary();
  if (bin) {
    try {
      const real = realpathSync(bin);
      const appJs = join(dirname(real), "app.js");
      const source = readFileSync(appJs, "utf8");
      const match = source.match(/TF=\[([^\]]*)\]/);
      if (match) {
        const names = JSON.parse(`[${match[1]}]`) as unknown;
        if (Array.isArray(names) && names.every((n) => typeof n === "string")) {
          return names as string[];
        }
      }
    } catch {
      // Fall back to the static list.
    }
  }
  return FALLBACK_BUILT_IN_MODELS;
}

export function loadCustomModels(): CustomModel[] {
  try {
    const parsed = JSON.parse(readFileSync(MODELS_FILE, "utf8")) as { models?: CustomModel[] };
    const models = parsed.models ?? [];
    return models.filter(
      (m) => typeof m.name === "string" && m.name && typeof m.env === "object" && m.env !== null,
    );
  } catch {
    return [];
  }
}

export function getCustomModel(name: string): CustomModel | undefined {
  return loadCustomModels().find((m) => m.name === name);
}

/**
 * User notes on models (cost, quality, preference), keyed by model name.
 * Shown by list_copilot_models so Claude can weigh them when choosing.
 */
export function loadAnnotations(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(MODELS_FILE, "utf8")) as {
      annotations?: unknown;
    };
    if (parsed.annotations && typeof parsed.annotations === "object") {
      const out: Record<string, string> = {};
      for (const [name, note] of Object.entries(parsed.annotations as Record<string, unknown>)) {
        if (typeof note === "string" && note) {
          out[name] = note;
        }
      }
      return out;
    }
  } catch {
    // No annotations configured.
  }
  return {};
}

/**
 * Copilot's persisted default model from ~/.copilot/settings.json, if set.
 * Note: a session created with an explicit model keeps that model on resume.
 */
export function getCopilotDefaultModel(): string | null {
  try {
    const settings = JSON.parse(
      readFileSync(join(homedir(), ".copilot", "settings.json"), "utf8"),
    ) as { model?: string };
    return settings.model || null;
  } catch {
    return null;
  }
}
