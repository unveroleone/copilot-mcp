import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { callCopilot } from "./copilot.js";
import {
  extractBuiltInModels,
  getCopilotDefaultModel,
  getCustomModel,
  loadAnnotations,
  loadCustomModels,
} from "./models.js";
import { getSession, listSessions, putSession, removeSession } from "./store.js";

const server = new McpServer({
  name: "copilot-mcp",
  version: "0.1.0",
});

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
      "(read-only review posture). Do not run two prompts on the same session at the same " +
      "time; Copilot sessions are single-writer.",
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
    },
  },
  async ({ session, prompt, model, workdir, timeoutMs, allowTools, effort }) => {
    const dir = workdir ?? process.cwd();
    const existing = getSession(session);

    if (existing && existing.workdir !== dir) {
      throw new Error(
        `Session "${session}" is bound to ${existing.workdir}, but workdir is ${dir}. ` +
          "Use a different session name for this project, or forget the session first.",
      );
    }

    const result = await callCopilot({
      prompt,
      workdir: dir,
      sessionId: existing?.copilotSessionId,
      model,
      effort,
      allowTools,
      timeoutMs,
      extraEnv: model ? getCustomModel(model)?.env : undefined,
    });

    if (result.exitCode !== 0 && !result.text) {
      const detail = result.stderr ? `\nstderr: ${result.stderr.slice(0, 2000)}` : "";
      throw new Error(`Copilot exited with code ${result.exitCode}.${detail}`);
    }

    if (result.sessionId) {
      const now = new Date().toISOString();
      putSession({
        name: session,
        copilotSessionId: result.sessionId,
        workdir: dir,
        model: model ?? null,
        createdAt: existing?.createdAt ?? now,
        lastUsedAt: now,
        turnCount: (existing?.turnCount ?? 0) + 1,
        lastPrompt: prompt.slice(0, 200),
      });
    }

    const header = `[copilot session "${session}" · turn ${(existing?.turnCount ?? 0) + 1}${result.model ? ` · model ${result.model}` : ""}]`;
    const parts = [header, ""];
    if (result.timedOut) {
      parts.push(`(timed out after ${timeoutMs ?? 300_000}ms; partial output follows)`);
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
    if (result.filesModified.length > 0) {
      parts.push(`\n(files modified: ${result.filesModified.join(", ")})`);
    }

    return { content: [{ type: "text" as const, text: parts.join("\n") }] };
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
        `model ${s.model ?? "auto"} · ${s.turnCount} turn(s) · last used ${s.lastUsedAt}`,
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
  },
  async ({ session }) => {
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
  },
  async () => {
    const custom = loadCustomModels();
    const builtIn = extractBuiltInModels();
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
    parts.push(
      `Copilot default model (from ~/.copilot/settings.json): ${fallback ?? "not set (auto)"}`,
    );

    parts.push("");
    parts.push("Built-in models (catalog of the installed Copilot CLI):");
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
await server.connect(transport);
