import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = realpathSync(mkdtempSync(join(tmpdir(), "copilot-mcp-test-")));
const workdir = join(home, "project");
const log = join(home, "argv.log");
let client: Client;

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const argvLog = (): string[][] =>
  readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const lastPromptArgv = () => argvLog().filter((a) => a[0] === "-p").at(-1)!;
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

before(async () => {
  mkdirSync(workdir);
  mkdirSync(join(home, ".copilot-mcp"));
  writeFileSync(
    join(home, ".copilot-mcp", "models.json"),
    JSON.stringify({
      annotations: { "fake-model-b": "cheap" },
      models: [
        {
          name: "byok",
          env: { COPILOT_PROVIDER_BASE_URL: "http://localhost", COPILOT_PROVIDER_API_KEY: "sk-x" },
        },
      ],
    }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(root, "src", "index.ts")],
    cwd: root,
    env: {
      ...(process.env as Record<string, string>),
      HOME: home,
      COPILOT_MCP_BIN: join(root, "test", "fake-copilot.mjs"),
      FAKE_COPILOT_LOG: log,
    },
  });
  client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
});

after(async () => {
  await client.close();
  rmSync(home, { recursive: true, force: true });
});

test("list_copilot_models reads the catalog from `copilot help config`", async () => {
  const out = text(await call("list_copilot_models"));
  assert.match(out, /installed Copilot CLI 9\.9\.9/);
  assert.match(out, /fake-model-a, fake-model-b — cheap/);
  assert.match(out, /- byok/);
});

test("a session keeps one Copilot session id across turns", async () => {
  const first = text(
    await call("delegate_to_copilot", { session: "app:rev", prompt: "hi", workdir, effort: "low" }),
  );
  assert.match(first, /turn 1 · model fake-model-a/);
  assert.match(first, /echo: hi/);
  const argv1 = lastPromptArgv();
  const id = flag(argv1, "--session-id");
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(flag(argv1, "--reasoning-effort"), "low");
  assert.ok(argv1.includes("--no-ask-user"));

  const second = text(await call("delegate_to_copilot", { session: "app:rev", prompt: "again", workdir }));
  assert.match(second, /turn 2/);
  assert.equal(flag(lastPromptArgv(), "--session-id"), id);
});

test("workdir must be an existing absolute directory and match the binding", async () => {
  const rel = await call("delegate_to_copilot", { session: "x", prompt: "hi", workdir: "project" });
  assert.equal(rel.isError, true);
  assert.match(text(rel), /absolute/);

  const missing = await call("delegate_to_copilot", { session: "x", prompt: "hi", workdir: join(home, "nope") });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /does not exist/);

  const moved = await call("delegate_to_copilot", { session: "app:rev", prompt: "hi", workdir: home });
  assert.equal(moved.isError, true);
  assert.match(text(moved), /is bound to/);
});

test("a failed first turn is reported and not tracked", async () => {
  const res = await call("delegate_to_copilot", { session: "app:fail", prompt: "fail", workdir });
  assert.equal(res.isError, true);
  assert.match(text(res), /Access denied by policy/);
  assert.doesNotMatch(text(await call("list_copilot_sessions")), /app:fail/);
});

test("timeouts return partial output, and a busy session rejects a second turn", async () => {
  const slow = call("delegate_to_copilot", { session: "app:slow", prompt: "hang", workdir, timeoutMs: 1_500 });
  await new Promise((r) => setTimeout(r, 300));
  const clash = await call("delegate_to_copilot", { session: "app:slow", prompt: "hi", workdir });
  assert.equal(clash.isError, true);
  assert.match(text(clash), /already has a turn running/);

  const out = text(await slow);
  assert.match(out, /timed out after 1500ms/);
  assert.match(out, /echo: hang/);
  // The session id was assigned up front, so the timed-out session is still resumable.
  assert.match(text(await call("list_copilot_sessions")), /app:slow/);
});

test("BYOK secrets are passed to --secret-env-vars", async () => {
  await call("delegate_to_copilot", { session: "app:byok", prompt: "hi", workdir, model: "byok" });
  const argv = lastPromptArgv();
  assert.ok(argv.includes("--secret-env-vars=COPILOT_PROVIDER_API_KEY"));
  assert.equal(flag(argv, "--model"), "byok");
});
