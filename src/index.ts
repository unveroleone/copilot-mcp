import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { callCopilot, DEFAULT_TIMEOUT_MS, killAll } from "./copilot.js";
import {
  extractBuiltInModels,
  getCopilotDefaultModel,
  getCopilotVersion,
  getCustomModel,
  loadAnnotations,
  loadCustomModels,
} from "./models.js";
import { beginAttempt, recordTriage } from "./ledger.js";
import { getSession, listSessions, putSession, removeSession } from "./store.js";

const server = new McpServer({
  name: "copilot-mcp",
  version: "0.2.0",
});

// Sessions with a turn in flight; Copilot sessions are single-writer.
const busy = new Set<string>();

function resolveWorkdir(workdir: string | undefined): string {
  const dir = workdir ?? process.cwd();
  if (!isAbsolute(dir)) {
    throw new Error(`workdir must be an absolute path, got "${dir}".`);
  }
  let real: string;
  try {
    real = realpathSync(resolve(dir));
  } catch {
    throw new Error(`workdir ${dir} does not exist.`);
  }
  if (!statSync(real).isDirectory()) {
    throw new Error(`workdir ${dir} is not a directory.`);
  }
  return real;
}

const sessionNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/,
    'session must be a stable name like "my-app:reviewer" (letters, digits, and : _ . -)',
  );

server.registerTool(
  "delegate_to_copilot",
  {
    title: "Delegate to Copilot",
    description:
      "Send a prompt to GitHub Copilot CLI as a persistent second agent. " +
      "Each session name keeps its own conversation history inside Copilot, so later " +
      "calls with the same name continue the same conversation and can reference earlier " +
      "findings. Use a stable name per project and role, e.g. \"my-app:reviewer\". " +
      "Sessions are bound to one working directory; pass workdir as the absolute project " +
      "path. Without allowTools the session cannot modify files or run arbitrary commands " +
      "(read-only review posture). Calls on a session that already has a turn running are " +
      "rejected; Copilot sessions are single-writer. Different session names run in parallel.",
    inputSchema: {
      session: sessionNameSchema,
      prompt: z.string().min(1, "prompt must not be empty"),
      model: z
        .string()
        .optional()
        .describe(
          'Model name as Copilot understands it, e.g. "gpt-5.4" or a custom provider id. Omit to let Copilot pick automatically. Call list_copilot_models first; it includes the user\'s cost/quality notes to weigh when choosing.',
        ),
      workdir: z
        .string()
        .optional()
        .describe(
          "Absolute path of the project the session works on. Defaults to the server's working directory.",
        ),
      timeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(1_800_000)
        .optional()
        .describe("Timeout in milliseconds (default 300000)."),
      allowTools: z
        .array(z.string())
        .optional()
        .describe(
          'Tools to grant without confirmation, e.g. ["write"] or ["shell(git:*)]. Omit for a read-only session.',
        ),
      effort: z
        .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
        .optional()
        .describe("Reasoning effort for this turn. Omit for Copilot default."),
      denyTools: z
        .array(z.string())
        .optional()
        .describe(
          'Tools to deny outright; takes precedence over allowTools, e.g. ["shell(git push)"].',
        ),
      addDirs: z
        .array(z.string())
        .optional()
        .describe("Extra absolute directories the session may access besides workdir."),
      attachments: z
        .array(z.string())
        .optional()
        .describe("Absolute paths of images or documents to attach to this prompt."),
      maxAiCredits: z
        .number()
        .positive()
        .optional()
        .describe("Cap on AI credits Copilot may spend on this turn."),
      reviewKind: z
        .enum(["code", "plan", "other"])
        .optional()
        .describe("What this call reviews. Recorded in the local review ledger."),
      episode: z
        .string()
        .max(200)
        .optional()
        .describe(
          'Stable id for the change under review, shared by its retries and later passes, e.g. "task-087-phase-2".',
        ),
      pass: z
        .enum(["initial", "revision", "verification", "retry"])
        .optional()
        .describe(
          "Where this call sits in the episode: first review, review of a changed revision, confirming fixes, or repeating a failed attempt.",
        ),
      author: z
        .string()
        .max(100)
        .optional()
        .describe(
          'Model that wrote the work under review, or "mixed" or "unknown". Leave out rather than guess.',
        ),
    },
    annotations: { openWorldHint: true },
  },
  async (
    {
      session, prompt, model, workdir, timeoutMs, allowTools, effort, denyTools, addDirs,
      attachments, maxAiCredits, reviewKind, episode, pass, author,
    },
    extra,
  ) => {
    const dir = resolveWorkdir(workdir);
    const existing = getSession(session);

    if (existing && existing.workdir !== dir) {
      throw new Error(
        `Session "${session}" is bound to ${existing.workdir}, but workdir is ${dir}. ` +
          "Use a different session name for this project, or forget the session first.",
      );
    }
    if (busy.has(session)) {
      throw new Error(
        `Session "${session}" already has a turn running. Wait for it to finish, or use a ` +
          "different session name to work in parallel.",
      );
    }

    const progressToken = extra._meta?.progressToken;
    let progress = 0;
    const onProgress =
      progressToken === undefined
        ? undefined
        : (message: string) => {
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: { progressToken, progress: ++progress, message },
              })
              .catch(() => {});
          };

    busy.add(session);
    let attempt;
    let result;
    try {
      attempt = await beginAttempt({
        session,
        workdir: dir,
        client: server.server.getClientVersion() ?? null,
        priorTurns: existing?.turnCount ?? 0,
        copilotSessionId: existing?.copilotSessionId ?? null,
        prompt,
        requestedModel: model ?? null,
        effort: effort ?? null,
        timeoutMs: timeoutMs ?? null,
        allowTools: allowTools ?? [],
        addDirs: addDirs ?? [],
        attachments: attachments ?? [],
        reviewKind: reviewKind ?? null,
        episode: episode ?? null,
        pass: pass ?? null,
        author: author ?? null,
      });
      try {
        result = await callCopilot({
          prompt,
          workdir: dir,
          sessionId: existing?.copilotSessionId,
          model,
          effort,
          allowTools,
          denyTools,
          addDirs,
          attachments,
          maxAiCredits,
          timeoutMs,
          extraEnv: model ? getCustomModel(model)?.env : undefined,
          signal: extra.signal,
          onProgress,
        });
      } catch (err) {
        attempt.fail(err);
        if (attempt.warning && err instanceof Error) {
          err.message += `\n(warning: ${attempt.warning})`;
        }
        throw err;
      }
      // Before anything below can throw, so failed starts stay on record.
      await attempt.finish(result);
    } finally {
      busy.delete(session);
    }

    // A turn that produced nothing and failed never started the session (bad model, auth,
    // policy); do not record it.
    const started = result.exitCode === 0 || result.text !== "" || result.timedOut;
    if (!started) {
      const detail = [
        result.stderr ? `stderr: ${result.stderr.slice(0, 2000)}` : "",
        result.sessionError ? `session error: ${result.sessionError.message}` : "",
        attempt.id ? `(review attempt: ${attempt.id})` : "",
        attempt.warning ? `(warning: ${attempt.warning})` : "",
      ]
        .filter(Boolean)
        .map((line) => `\n${line}`)
        .join("");
      throw new Error(`Copilot exited with code ${result.exitCode}.${detail}`);
    }

    const turn = (existing?.turnCount ?? 0) + 1;
    const now = new Date().toISOString();
    putSession({
      name: session,
      copilotSessionId: result.sessionId,
      workdir: dir,
      // A resumed session keeps its model unless one is passed explicitly.
      model: result.model ?? model ?? existing?.model ?? null,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      turnCount: turn,
      lastPrompt: prompt.slice(0, 200),
    });

    const header = `[copilot session "${session}" · turn ${turn}${result.model ? ` · model ${result.model}` : ""}]`;
    const parts = [header, ""];
    if (result.aborted) {
      parts.push("(cancelled; partial output follows)");
    } else if (result.timedOut) {
      parts.push(`(timed out after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms; partial output follows)`);
    }
    if (result.text) {
      parts.push(result.text);
    } else {
      parts.push("(no text output)");
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr ? `\nstderr: ${result.stderr.slice(0, 2000)}` : "";
      parts.push(`\n(warning: exit code ${result.exitCode})${detail}`);
    }
    if (result.sessionError) {
      // Copilot can report an error and still exit 0; that must not read as a clean review.
      parts.push(`\n(warning: Copilot session error: ${result.sessionError.message})`);
    }
    if (result.filesModified.length > 0) {
      parts.push(`\n(files modified: ${result.filesModified.join(", ")})`);
    }
    if (result.premiumRequests > 0) {
      parts.push(`\n(premium requests: ${result.premiumRequests})`);
    }
    if (attempt.id) {
      parts.push(`\n(review attempt: ${attempt.id})`);
    }
    if (attempt.warning) {
      parts.push(`\n(warning: ${attempt.warning})`);
    }

    return { content: [{ type: "text" as const, text: parts.join("\n") }] };
  },
);

server.registerTool(
  "record_review_triage",
  {
    title: "Record Review Triage",
    description:
      "Record what you decided about a completed review, using the attempt id from the " +
      "delegate_to_copilot response. List every finding with your honest disposition; pass an " +
      "empty findings list for a clean review. This is stored as your opinion, not as proof " +
      "that a finding was right or wrong. Disposition is what you chose to do, so a real " +
      "problem you decided not to fix is still deferred or rejected. Do not call it for failed " +
      "or empty attempts. For plan reviews, include the plan before and after, plus the " +
      "decisions that changed.",
    inputSchema: {
      attemptId: z.uuid(),
      findings: z.array(
        z.object({
          claim: z.string().min(1).max(2000).describe("The finding, close to the reviewer's words."),
          reviewerSeverity: z
            .string()
            .max(50)
            .optional()
            .describe("The severity label the reviewer used, unchanged. Leave out if it gave none."),
          disposition: z.enum(["accepted", "rejected", "deferred", "unknown"]),
          note: z.string().max(2000).optional().describe("Why, in one or two sentences."),
        }),
      ),
      decisionsChanged: z
        .array(z.string().min(1).max(2000))
        .optional()
        .describe("Plan reviews: each decision that changed because of the review."),
      planBefore: z.string().optional().describe("Plan reviews: the plan as it was reviewed."),
      planAfter: z.string().optional().describe("Plan reviews: the plan after the review."),
      note: z.string().max(4000).optional(),
    },
    annotations: { idempotentHint: false },
  },
  async ({ attemptId, findings, decisionsChanged, planBefore, planAfter, note }) => {
    const recorded = recordTriage({
      attemptId,
      findings,
      decisionsChanged,
      planBefore,
      planAfter,
      note,
      client: server.server.getClientVersion() ?? null,
    });
    if (!recorded) throw new Error(`Review attempt ${attemptId} is not in the ledger.`);
    return {
      content: [
        {
          type: "text" as const,
          text: `Triage recorded for attempt ${attemptId}: ${findings.length} finding(s).`,
        },
      ],
    };
  },
);

server.registerTool(
  "list_copilot_sessions",
  {
    title: "List Copilot Sessions",
    description:
      "List all Copilot sessions tracked by this bridge: session name, Copilot session id, " +
      "working directory, model, and turn count.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const sessions = listSessions();
    if (sessions.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No Copilot sessions tracked yet." }],
      };
    }
    const lines = sessions.map(
      (s) =>
        `${s.name} (${s.copilotSessionId.slice(0, 8)}) · ${s.workdir} · ` +
        `model ${s.model ?? "auto"} · ${s.turnCount} turn(s) · last used ${s.lastUsedAt}` +
        (busy.has(s.name) ? " · running" : "") +
        (s.lastPrompt ? `\n  last prompt: ${s.lastPrompt.replace(/\s+/g, " ").slice(0, 120)}` : ""),
    );
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

server.registerTool(
  "forget_copilot_session",
  {
    title: "Forget Copilot Session",
    description:
      "Remove a session from the bridge's tracking so the next delegation with the same name " +
      "starts a fresh Copilot session. Copilot's own stored session files on disk are not " +
      "deleted, only the bridge's mapping.",
    inputSchema: {
      session: sessionNameSchema,
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  async ({ session }) => {
    if (busy.has(session)) {
      throw new Error(`Session "${session}" has a turn running; forget it after it finishes.`);
    }
    const removed = removeSession(session);
    return {
      content: [
        {
          type: "text" as const,
          text: removed
            ? `Session "${session}" forgotten; the next delegation starts a new Copilot session.`
            : `Session "${session}" was not tracked.`,
        },
      ],
    };
  },
);

server.registerTool(
  "list_copilot_models",
  {
    title: "List Copilot Models",
    description:
      "Lists models available to delegate_to_copilot: custom models configured in " +
      "~/.copilot-mcp/models.json (BYOK providers), Copilot's persisted default model, and " +
      "the built-in model catalog of the installed Copilot CLI. Pass a listed name as the " +
      "model argument of delegate_to_copilot. Availability of built-in models depends on the " +
      "GitHub account's plan; Copilot errors clearly if a model is not available, in which " +
      "case pick a different one.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const custom = loadCustomModels();
    const { models: builtIn, source } = extractBuiltInModels();
    const version = getCopilotVersion();
    const fallback = getCopilotDefaultModel();
    const annotations = loadAnnotations();

    const parts: string[] = [];

    if (custom.length > 0) {
      parts.push("Custom models (BYOK, configured in ~/.copilot-mcp/models.json):");
      for (const m of custom) {
        parts.push(`- ${m.name}${m.description ? ` — ${m.description}` : ""}`);
      }
    } else {
      parts.push(
        "Custom models: none configured. Add entries to ~/.copilot-mcp/models.json, e.g.:\n" +
          '{\n  "models": [{\n    "name": "deepseek-v4-pro",\n    "description": "DeepSeek V4 Pro (BYOK)",\n' +
          '    "env": {\n      "COPILOT_PROVIDER_BASE_URL": "https://api.deepseek.com/v1",\n' +
          '      "COPILOT_PROVIDER_TYPE": "openai",\n      "COPILOT_PROVIDER_API_KEY": "sk-...",\n' +
          '      "COPILOT_MODEL": "deepseek-v4-pro"\n    }\n  }]\n}',
      );
    }

    parts.push("");
    parts.push(`Copilot default model: ${fallback ?? "not set (auto)"}`);

    parts.push("");
    parts.push(
      source === "fallback"
        ? "Built-in models (static list; the installed Copilot CLI could not be queried):"
        : `Built-in models (catalog of the installed Copilot CLI${version ? ` ${version}` : ""}):`,
    );
    parts.push(
      builtIn
        .map((name) => (annotations[name] ? `${name} — ${annotations[name]}` : name))
        .join(", "),
    );

    const annotatedOutside = Object.entries(annotations)
      .filter(([name]) => !builtIn.includes(name))
      .sort(([a], [b]) => a.localeCompare(b));
    if (annotatedOutside.length > 0) {
      parts.push("");
      parts.push(
        "Other models you have noted (not in the installed CLI's static catalog; " +
          "they may still work if your account offers them):",
      );
      for (const [name, note] of annotatedOutside) {
        parts.push(`- ${name} — ${note}`);
      }
    }

    parts.push(
      "\nNote: plan limits apply; if Copilot reports a model as unavailable, try another one.",
    );

    return { content: [{ type: "text" as const, text: parts.join("\n") }] };
  },
);

const transport = new StdioServerTransport();
// Claude Code closes stdin when it disconnects; do not leave Copilot runs behind.
process.stdin.on("close", () => {
  killAll();
  process.exit(0);
});
await server.connect(transport);
