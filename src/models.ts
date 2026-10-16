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

// Static fallback catalog, used when the installed Copilot CLI cannot be queried.
// Mirrors `copilot help config` of Copilot CLI 1.0.98.
const FALLBACK_BUILT_IN_MODELS = [
  "claude-sonnet-5.5",
  "claude-sonnet-5",
  "claude-fable-5.1",
  "claude-fable-5",
  "claude-opus-5.5",
  "claude-opus-5",
  "claude-opus-4.8",
  "claude-opus-4.8-fast",
  "claude-sonnet-4.6",
  "claude-haiku-5.5",
  "claude-haiku-4.5",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5-mini",
  "mai-code-1.1-flash",
  "gemini-4-argon",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "grok-4.7",
  "grok-4.6",
  "grok-4.5",
  "kimi-k3",
];

export type CatalogSource = "cli-help" | "bundle" | "fallback";

const copilotBin = () => process.env.COPILOT_MCP_BIN ?? "copilot";

export function resolveCopilotBinary(): string | null {
  const res = spawnSync("which", [copilotBin()], { encoding: "utf8" });
  const found = res.stdout?.trim();
  return found || null;
}

export function getCopilotVersion(): string | null {
  const res = spawnSync(copilotBin(), ["--version"], { encoding: "utf8", timeout: 10_000 });
  return res.stdout?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

/**
 * Parses the `model` entry of `copilot help config`, which lists every model name the
 * installed CLI accepts as quoted bullet points.
 */
export function parseConfigHelpModels(help: string): string[] {
  const section = help.match(/^ {2}`model`:[^\n]*\n((?: {4}[^\n]*\n?)*)/m)?.[1] ?? "";
  return [...section.matchAll(/^ {4}- "([^"]+)"/gm)].map((m) => m[1]);
}

function modelsFromConfigHelp(): string[] {
  const res = spawnSync(copilotBin(), ["help", "config"], { encoding: "utf8", timeout: 15_000 });
  return res.status === 0 ? parseConfigHelpModels(res.stdout ?? "") : [];
}

/**
 * Older JS-bundled CLIs ship app.js with the catalog as a TF=[...] array. Native-binary
 * installs (1.0.9x via npm) have no app.js.
 */
function modelsFromBundle(): string[] {
  const bin = resolveCopilotBinary();
  if (!bin) return [];
  try {
    const appJs = join(dirname(realpathSync(bin)), "app.js");
    const match = readFileSync(appJs, "utf8").match(/TF=\[([^\]]*)\]/);
    if (match) {
      const names = JSON.parse(`[${match[1]}]`) as unknown;
      if (Array.isArray(names) && names.every((n) => typeof n === "string")) {
        return names as string[];
      }
    }
  } catch {
    // Not a JS bundle.
  }
  return [];
}

let cachedCatalog: { version: string | null; models: string[]; source: CatalogSource } | null =
  null;

/**
 * Built-in model catalog of the installed Copilot CLI, cached per CLI version.
 */
export function extractBuiltInModels(): { models: string[]; source: CatalogSource } {
  const version = getCopilotVersion();
  if (cachedCatalog && cachedCatalog.version === version) return cachedCatalog;

  let models = modelsFromConfigHelp();
  let source: CatalogSource = "cli-help";
  if (models.length === 0) {
    models = modelsFromBundle();
    source = "bundle";
  }
  if (models.length === 0) {
    models = FALLBACK_BUILT_IN_MODELS;
    source = "fallback";
  }
  cachedCatalog = { version, models, source };
  return cachedCatalog;
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
 * Copilot's default model: COPILOT_MODEL, else the persisted one in $COPILOT_HOME/settings.json.
 * Note: a session created with an explicit model keeps that model on resume.
 */
export function getCopilotDefaultModel(): string | null {
  if (process.env.COPILOT_MODEL) return process.env.COPILOT_MODEL;
  try {
    const home = process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
    const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as {
      model?: string;
    };
    return settings.model || null;
  } catch {
    return null;
  }
}
