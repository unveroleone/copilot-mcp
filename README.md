# copilot-mcp

Let your coding agent ask GitHub Copilot for a second opinion.

copilot-mcp is a small [MCP](https://modelcontextprotocol.io) server that wraps the GitHub
Copilot CLI. Claude Code, OpenCode, Codex or any other MCP client can hand a prompt to Copilot,
get the answer back, and come back to the same conversation later. Copilot runs read-only by default, which makes it a good fit for code
review, plan checks and "does this approach hold up?" questions.

```text
You:     Review my changes, then get a second opinion from Copilot.
Claude:  [calls delegate_to_copilot with session "my-app:reviewer"]
Copilot: Two issues: the retry loop never resets its counter, and ...
You:     Fixed. Ask it to check again.
Claude:  [same session, Copilot remembers the first review]
```

## Why use it

- **A different model looks at your code.** Claude reviewing its own work tends to agree with
  itself. Copilot gives you another model's view, such as the GPT models and any others your
  Copilot plan includes.
- **Sessions persist.** Each named session keeps its history inside Copilot. A follow-up call can
  refer to earlier findings without resending the whole context.
- **Safe by default.** Copilot cannot edit files or run commands unless the call grants it
  explicit permission.
- **Uses your existing Copilot plan.** No extra API keys. You can also plug in your own provider
  (DeepSeek, Ollama, Azure and others) if you want.

## Quick start

You need Node.js 20+, [pnpm](https://pnpm.io), [Claude Code](https://claude.com/claude-code), and
a GitHub account with Copilot.

**1. Install and sign in to the Copilot CLI**

```bash
npm install -g @github/copilot
copilot login
```

CLI access must be enabled for your account at https://github.com/settings/copilot.

**2. Build copilot-mcp**

```bash
git clone https://github.com/unveroleone/copilot-mcp
cd copilot-mcp
pnpm install
pnpm build
```

**3. Register it with your client (Claude Code shown)**

```bash
claude mcp add copilot -s user -- node "$PWD/dist/index.js"
```

Restart Claude Code or run `/mcp` to reconnect. The `copilot` server should now show up in
`/context`. Then ask Claude something like:

> Use Copilot to review the diff in this repo. Use a session called `my-app:reviewer`.

To remove it again: `claude mcp remove copilot -s user`.

### OpenCode, Codex and other clients

The server speaks MCP over stdio, so any client that can launch a local command works. Use the
absolute path to `dist/index.js` from step 2.

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.copilot]
command = "node"
args = ["/absolute/path/to/copilot-mcp/dist/index.js"]
```

OpenCode (`opencode.json`):

```json
{
  "mcp": {
    "copilot": {
      "type": "local",
      "command": ["node", "/absolute/path/to/copilot-mcp/dist/index.js"]
    }
  }
}
```

Most other clients use a generic `mcpServers` entry:

```json
{
  "mcpServers": {
    "copilot": {
      "command": "node",
      "args": ["/absolute/path/to/copilot-mcp/dist/index.js"]
    }
  }
}
```

## Requirements

- Node.js 20 or newer
- GitHub Copilot CLI 1.0.73 or newer, authenticated
- Verified against Copilot CLI 1.0.73 and 1.0.98

Set `COPILOT_MCP_BIN` in the server's environment if the `copilot` binary is not on your `PATH`.

## How it works

For each call the server starts `copilot -p` with `--output-format json` and reads the JSONL
event stream. On the first call for a session name it generates a UUID and passes it to Copilot
with `--session-id`. The name-to-UUID mapping is stored in `~/.copilot-mcp/sessions.json`. Later
calls with the same name pass the UUID again, which resumes the conversation with its full
history. Because the id is assigned up front, a session whose first turn timed out can still be
resumed.

Claude's context is not shared with Copilot, and the other way around. Only the prompt goes in
and the final answer comes out.

## Tools

| Tool | What it does |
| --- | --- |
| `delegate_to_copilot` | Send a prompt to a named Copilot session |
| `list_copilot_models` | List the models Claude can pick from, with your own notes |
| `list_copilot_sessions` | List tracked sessions with id prefix, working directory, model and turn count |
| `forget_copilot_session` | Drop a session so the next call with that name starts fresh |
| `record_review_triage` | Record what the calling agent decided about a review's findings |

### delegate_to_copilot

| Argument | Required | Description |
| --- | --- | --- |
| `session` | yes | Stable name per project and role, e.g. `my-app:reviewer` |
| `prompt` | yes | The prompt to send |
| `workdir` | no | Absolute project path the session works on. Defaults to the server's working directory |
| `model` | no | Model name Copilot understands, e.g. `gpt-5.4`. Omit for Copilot's automatic pick |
| `timeoutMs` | no | Timeout in milliseconds, default 300000 |
| `allowTools` | no | Tools granted without confirmation, e.g. `["write"]` or `["shell(git:*)"]`. Omit for read-only |
| `effort` | no | Reasoning effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `denyTools` | no | Tools to deny outright, e.g. `["shell(git push)"]`. Takes precedence over `allowTools` |
| `addDirs` | no | Extra absolute directories the session may access |
| `attachments` | no | Absolute paths of images or documents to attach to the prompt |
| `maxAiCredits` | no | Cap on AI credits Copilot may spend on the turn |
| `reviewKind` | no | What the call reviews: `code`, `plan` or `other`. Stored in the review ledger |
| `episode` | no | Stable id for the change under review, shared by its retries and later passes |
| `pass` | no | `initial`, `revision`, `verification` or `retry` |
| `author` | no | Model that wrote the reviewed work, or `mixed` or `unknown`. Stored as caller-declared |

Behavior worth knowing:

- Without `allowTools`, the session cannot modify files or run arbitrary commands. Grant tools
  explicitly when Copilot should act on the code.
- A session is bound to one working directory. `workdir` must be an absolute path to an existing
  directory, and symlinks are resolved before comparing. Calling a session with a different
  `workdir` returns an error; use a new session name or forget the old one.
- Sessions are single-writer. A call on a session that already has a turn running is rejected.
  Different session names run in parallel.
- Copilot runs with `--no-ask-user`, since nobody can answer a question in non-interactive mode.
- While a turn runs, the server sends MCP progress notifications for tool calls and messages.
- Cancelling the tool call, a timeout, or a client disconnect kills the whole Copilot process
  tree.
- The response ends with the files Copilot modified, the premium requests it used and the review
  attempt id.

### record_review_triage

Stores the calling agent's decision on each finding, keyed by the attempt id from
`delegate_to_copilot`. A finding is `accepted`, `rejected`, `deferred` or `unknown`. An empty
`findings` list means a clean review. Plan reviews can also pass `planBefore`, `planAfter` and
`decisionsChanged`.

The record is labeled as the implementing agent's opinion. It says what the agent chose to do,
not whether the finding was correct.

### list_copilot_models

Lists the models Claude can choose from:

- custom models from `~/.copilot-mcp/models.json`
- Copilot's default model (`COPILOT_MODEL`, else `$COPILOT_HOME/settings.json`)
- the built-in model catalog of the installed Copilot CLI

The built-in catalog is read from `copilot help config` at runtime and cached per CLI version,
so it matches the CLI on your machine. Older CLIs that ship a JS bundle are read from `app.js`.
If neither works, a static list is used and the output says so. Plan limits still apply: if
Copilot reports a model as unavailable, pick a different one.

### list_copilot_sessions

Lists every tracked session with its Copilot session id prefix, working directory, model and
turn count.

### forget_copilot_session

Removes a session from the server's tracking. The next delegation with the same name starts a
fresh Copilot session. Copilot's own session files on disk are left alone; only the mapping in
`~/.copilot-mcp/sessions.json` is removed.

## Review ledger

Every `delegate_to_copilot` call is logged locally under `~/.copilot-mcp/ledger/attempts/<id>/`,
so you can measure what reviews find. Nothing leaves your machine.

| File | Contents |
| --- | --- |
| `start.json` | Written before Copilot launches: session, client, requested model and review target |
| `end.json` | Outcome, duration, observed model and reported usage. Missing means the run was interrupted |
| `prompt.txt` | The prompt |
| `response.txt`, `final.txt` | All assistant messages, and the last one on its own |
| `target.patch` | Uncommitted changes and small untracked text files at the start of the run |
| `triage-*.json` | Records from `record_review_triage` |

The directory is readable only by your user. Secrets that match common token formats are redacted,
and `.env`, `.pem` and `.key` files are left out of the patch. Redaction is best effort, so treat
the ledger as private. If the ledger cannot write, the review still runs and the response carries a
warning.

## Configuration

Everything lives in `~/.copilot-mcp/`. All of it is optional.

| File | Purpose |
| --- | --- |
| `sessions.json` | Created automatically. Maps session names to Copilot session ids |
| `models.json` | Your custom models and per-model notes (see below) |

| Environment variable | Purpose |
| --- | --- |
| `COPILOT_MCP_BIN` | Path to the `copilot` binary if it is not on `PATH` |
| `COPILOT_MODEL` | Default model reported by `list_copilot_models` |
| `COPILOT_HOME` | Copilot's config directory, default `~/.copilot` |

### Custom models (bring your own provider)

Add providers to `~/.copilot-mcp/models.json`:

```json
{
  "models": [
    {
      "name": "deepseek-v4-pro",
      "description": "DeepSeek V4 Pro (BYOK)",
      "env": {
        "COPILOT_PROVIDER_BASE_URL": "https://api.deepseek.com/v1",
        "COPILOT_PROVIDER_TYPE": "openai",
        "COPILOT_PROVIDER_API_KEY": "sk-...",
        "COPILOT_MODEL": "deepseek-v4-pro"
      }
    }
  ]
}
```

When the `model` argument matches a custom model name, the server injects that entry's env vars
into that one Copilot process. BYOK mode is per process, so GitHub models and custom providers
do not interfere with each other. Env vars whose names contain `KEY`, `TOKEN`, `SECRET`,
`PASSWORD` or `HEADERS` are passed to `--secret-env-vars`, so Copilot strips them from its shell
and MCP subprocesses and redacts them from output.

The file contains API keys, so restrict its permissions:

```bash
chmod 600 ~/.copilot-mcp/models.json
```

The provider variables are documented in `copilot help providers`. The example above uses an
OpenAI-compatible endpoint; OpenAI, Azure, Anthropic, Moonshot and Ollama-style endpoints work
through `COPILOT_PROVIDER_TYPE`.

### Model notes

The same file accepts an `annotations` map with a free-form note per model. `list_copilot_models`
shows these next to the models, so Claude can weigh cost and quality when it picks one:

```json
{
  "annotations": {
    "kimi-k3": "medium cost, very good",
    "gpt-luna": "good but expensive"
  },
  "models": []
}
```

Annotated names that are not in the installed CLI's static catalog are listed separately. Some
models (like `kimi-k3`) are account-level Copilot models and work even when absent from that
catalog.

## Troubleshooting

- **`spawn copilot ENOENT`**: the CLI is not on the `PATH` that Claude Code sees. Install it or
  set `COPILOT_MCP_BIN`.
- **Auth errors**: run `copilot login` in a terminal, and check that CLI access is enabled at
  https://github.com/settings/copilot.
- **`Session "..." is bound to ...`**: the session was created for another directory. Use a new session
  name, or call `forget_copilot_session` first.
- **`Session "..." already has a turn running`**: another turn on that session is still going. Wait for it or use a
  different session name.
- **Model unavailable**: your plan may not include it. Call `list_copilot_models` and pick
  another.

## Development

```bash
pnpm dev        # run via tsx
pnpm typecheck  # tsc --noEmit
pnpm build      # compile to dist/
pnpm test       # end-to-end tests against a fake copilot binary
```

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
