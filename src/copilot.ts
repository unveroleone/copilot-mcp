import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

export interface CopilotCallOptions {
  prompt: string;
  workdir?: string;
  // Pass an existing Copilot session UUID to resume it; omit to start a new session.
  sessionId?: string;
  // Model name as Copilot understands it (e.g. "gpt-5.4", or a custom provider id).
  // Omit to let Copilot pick automatically.
  model?: string;
  effort?: string;
  allowTools?: string[];
  denyTools?: string[];
  // Extra directories the session may read and write besides workdir.
  addDirs?: string[];
  // Files (images, documents) attached to the prompt.
  attachments?: string[];
  maxAiCredits?: number;
  timeoutMs?: number;
  // Extra environment variables for the spawned process (BYOK provider config).
  extraEnv?: Record<string, string>;
  // Cancels the run; the Copilot process tree is killed.
  signal?: AbortSignal;
  // Called with a short human-readable line for each notable stream event.
  onProgress?: (message: string) => void;
}

export interface CopilotCallResult {
  // Every assistant message of the turn, joined. Can include preliminary statements.
  text: string;
  // Only the last assistant message, which is normally the actual answer.
  finalText: string;
  sessionId: string;
  model: string | null;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  stderr: string;
  filesModified: string[];
  premiumRequests: number;
  // False when Copilot sent no usage figure, so premiumRequests is a default, not a measurement.
  premiumRequestsReported: boolean;
  sessionError: { type: string; message: string } | null;
}

export const DEFAULT_TIMEOUT_MS = 300_000;

// Env var names whose values must not leak into Copilot's shell and MCP subprocesses.
const SECRET_ENV_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|HEADERS/i;

// Every running Copilot process tree, so they can be killed when the server exits.
const active = new Set<ChildProcess>();

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    // The npm `copilot` entry is a Node loader that spawns the native binary; killing
    // only the loader would orphan the binary, so signal the whole process group.
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export function killAll(): void {
  for (const child of active) killTree(child, "SIGKILL");
}

process.on("exit", killAll);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

export function buildArgs(opts: CopilotCallOptions, sessionId: string): string[] {
  const args = [
    "-p", opts.prompt,
    "--output-format", "json",
    "--no-color",
    // Nobody can answer a question in non-interactive mode.
    "--no-ask-user",
    "--session-id", sessionId,
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--reasoning-effort", opts.effort);
  for (const tool of opts.allowTools ?? []) args.push("--allow-tool", tool);
  for (const tool of opts.denyTools ?? []) args.push("--deny-tool", tool);
  for (const dir of opts.addDirs ?? []) args.push("--add-dir", dir);
  for (const file of opts.attachments ?? []) args.push("--attachment", file);
  if (opts.maxAiCredits !== undefined) args.push("--max-ai-credits", String(opts.maxAiCredits));
  const secrets = Object.keys(opts.extraEnv ?? {}).filter((k) => SECRET_ENV_PATTERN.test(k));
  if (secrets.length > 0) args.push(`--secret-env-vars=${secrets.join(",")}`);
  return args;
}

function describeEvent(event: Record<string, unknown>): string | null {
  const type = String(event.type ?? "");
  const data = (event.data ?? {}) as Record<string, unknown>;
  const tool = data.toolName ?? data.name;
  if (type.startsWith("tool.") && type.endsWith("start") && typeof tool === "string") {
    return `copilot: running ${tool}`;
  }
  if (type === "assistant.message" && typeof data.content === "string" && data.content.trim()) {
    return `copilot: ${data.content.trim().split("\n")[0].slice(0, 120)}`;
  }
  return null;
}

/**
 * Runs one non-interactive Copilot CLI turn and parses its JSONL event stream.
 * The final assistant message is returned as text. New sessions get a UUID up front
 * via --session-id, so the session can be resumed even if this turn times out.
 */
export function callCopilot(opts: CopilotCallOptions): Promise<CopilotCallResult> {
  return new Promise((resolve, reject) => {
    const sessionId = opts.sessionId ?? randomUUID();
    const child = spawn(process.env.COPILOT_MCP_BIN ?? "copilot", buildArgs(opts, sessionId), {
      cwd: opts.workdir,
      env: { ...process.env, ...(opts.extraEnv ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    active.add(child);

    const messages: string[] = [];
    let model: string | null = null;
    let resultEvent: Record<string, unknown> | null = null;
    let sessionError: { type: string; message: string } | null = null;
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const stop = () => {
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), 5_000).unref();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "assistant.message") {
        const data = event.data as Record<string, unknown> | undefined;
        if (typeof data?.content === "string" && data.content.trim()) {
          messages.push(data.content);
        }
        if (typeof data?.model === "string") {
          model = data.model;
        }
      } else if (event.type === "result") {
        resultEvent = event;
      } else if (event.type === "session.error") {
        const data = (event.data ?? {}) as Record<string, unknown>;
        sessionError = {
          type: String(data.errorType ?? "unknown"),
          message: String(data.message ?? "").slice(0, 2000),
        };
      }
      const progress = opts.onProgress && describeEvent(event);
      if (progress) opts.onProgress!(progress);
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      // Keep the tail; long runs can write a lot of diagnostics.
      stderr = (stderr + chunk.toString()).slice(-20_000);
    });

    const cleanup = () => {
      clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
      active.delete(child);
    };

    child.on("error", (err) => {
      cleanup();
      reject(
        new Error(
          `Failed to start the Copilot CLI: ${err.message}. ` +
            "Make sure `copilot` is installed, authenticated (`copilot login`), and on PATH.",
        ),
      );
    });

    child.on("close", (code) => {
      cleanup();
      const usage = (resultEvent?.usage ?? {}) as Record<string, unknown>;
      const codeChanges = (usage.codeChanges ?? {}) as Record<string, unknown>;
      resolve({
        text: messages.join("\n\n").trim(),
        finalText: messages.at(-1)?.trim() ?? "",
        sessionId: (resultEvent?.sessionId as string | undefined) ?? sessionId,
        model,
        exitCode: code,
        timedOut,
        aborted,
        stderr: stderr.trim(),
        filesModified: Array.isArray(codeChanges.filesModified)
          ? (codeChanges.filesModified as string[])
          : [],
        premiumRequests: typeof usage.premiumRequests === "number" ? usage.premiumRequests : 0,
        premiumRequestsReported: typeof usage.premiumRequests === "number",
        sessionError,
      });
    });
  });
}
