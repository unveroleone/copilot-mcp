import { spawn } from "node:child_process";
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
  timeoutMs?: number;
  // Extra environment variables for the spawned process (BYOK provider config).
  extraEnv?: Record<string, string>;
}

export interface CopilotCallResult {
  text: string;
  sessionId: string | null;
  model: string | null;
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
  filesModified: string[];
  premiumRequests: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Runs one non-interactive Copilot CLI turn and parses its JSONL event stream.
 * The final assistant message is returned as text; the session UUID comes from
 * the stream's "result" event.
 */
export function callCopilot(opts: CopilotCallOptions): Promise<CopilotCallResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", opts.prompt,
      "--output-format", "json",
      "--no-color",
    ];
    if (opts.sessionId) args.push("--session-id", opts.sessionId);
    if (opts.model) args.push("--model", opts.model);
    if (opts.effort) args.push("--effort", opts.effort);
    for (const tool of opts.allowTools ?? []) args.push("--allow-tool", tool);

    const child = spawn("copilot", args, {
      cwd: opts.workdir,
      env: { ...process.env, ...(opts.extraEnv ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const messages: string[] = [];
    let model: string | null = null;
    let resultEvent: Record<string, unknown> | null = null;
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const rl = createInterface({ input: child.stdout });
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
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Failed to start the Copilot CLI: ${err.message}. ` +
            "Make sure `copilot` is installed, authenticated (`copilot login`), and on PATH.",
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      const usage = (resultEvent?.usage ?? {}) as Record<string, unknown>;
      const codeChanges = (usage.codeChanges ?? {}) as Record<string, unknown>;
      resolve({
        text: messages.join("\n\n").trim(),
        sessionId: (resultEvent?.sessionId as string) ?? null,
        model,
        exitCode: code,
        timedOut,
        stderr: stderr.trim(),
        filesModified: Array.isArray(codeChanges.filesModified)
          ? (codeChanges.filesModified as string[])
          : [],
        premiumRequests: typeof usage.premiumRequests === "number" ? usage.premiumRequests : 0,
      });
    });
  });
}
