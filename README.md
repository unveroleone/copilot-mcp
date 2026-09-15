# copilot-mcp

An MCP server that lets Claude Code delegate prompts to GitHub Copilot CLI and treat it as a
persistent second agent. Each named session keeps its own conversation history inside Copilot,
so a later call can reference earlier findings without resending context.

## How it works

The bridge spawns `copilot -p` with `--output-format json` and parses the JSONL event stream.
On the first call for a session name it starts a new Copilot session, reads the session UUID
from the stream's `result` event, and stores the mapping in `~/.copilot-mcp/sessions.json`.
Every later call for the same name passes that UUID back via `--session-id`, which resumes the
conversation with its full history.

Claude's own context is not shared with Copilot and vice versa. The bridge only passes the
prompt and returns the final Copilot response.

## Requirements

- Node.js 20 or newer, pnpm
- GitHub Copilot CLI 1.0.73 or newer, authenticated (`copilot login`)
- Verified against Copilot CLI 1.0.73

## Installation

```bash
cd ~/projects/private/copilot-mcp
pnpm install
pnpm build

claude mcp add copilot -- pnpm -C "$PWD" exec tsx src/index.ts
```

Restart Claude Code or run `/mcp` to reconnect. The `copilot` MCP server then shows up in
`/context` alongside the other servers.

Run `claude mcp remove copilot` to unregister.

## Tools

### delegate_to_copilot

Sends a prompt to a named Copilot session.

| Argument | Required | Description |
| --- | --- | --- |
| `session` | yes | Stable name per project and role, e.g. `my-app:reviewer` |
| `prompt` | yes | The prompt to send |
| `workdir` | no | Absolute project path the session works on. Defaults to the server's working directory |
| `model` | no | Model name Copilot understands, e.g. `gpt-5.4`. Omit for Copilot's automatic pick |
| `timeoutMs` | no | Timeout in milliseconds, default 300000 |
| `allowTools` | no | Tools granted without confirmation, e.g. `["write"]` or `["shell(git:*)"]`. Omit for read-only |
| `effort` | no | Reasoning effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |

Without `allowTools` the session cannot modify files or run arbitrary commands. That default
matches the reviewer use case. Grant tools explicitly when the session should act on the code.

Sessions are bound to one working directory. Calling a session with a different `workdir`
returns an error; use a new session name or forget the old one.

Copilot sessions are single-writer. Do not run two prompts on the same session at the same time.

### list_copilot_models

Lists the models Claude can pick from:

- custom models from `~/.copilot-mcp/models.json`
- Copilot's persisted default model from `~/.copilot/settings.json`
- the built-in model catalog of the installed Copilot CLI

The built-in catalog is read from the installed Copilot bundle at runtime, so it matches the
CLI version on the machine. Plan limits still apply; if Copilot reports a model as unavailable,
pick a different one. Use a listed name as the `model` argument of `delegate_to_copilot`.

### list_copilot_sessions

Lists every tracked session with its Copilot session id prefix, working directory, model, and
turn count.

### forget_copilot_session

Removes a session from the bridge's tracking. The next delegation with the same name starts a
fresh Copilot session. Copilot's own session files on disk are left alone; only the mapping in
`~/.copilot-mcp/sessions.json` is removed.

## Models

The `model` argument is passed through to Copilot. Custom models (BYOK providers) are
configured in `~/.copilot-mcp/models.json`:

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

When the `model` argument matches a custom model name, the bridge injects its env vars into
that one Copilot process. BYOK mode is per process, so GitHub models and custom providers do
not interfere with each other. The file contains API keys; set its permissions accordingly:

```bash
chmod 600 ~/.copilot-mcp/models.json
```

The provider env vars are documented in `copilot help providers`. The example above is an
OpenAI-compatible endpoint; OpenAI, Azure, Anthropic, Moonshot, and Ollama-style endpoints all
work through `COPILOT_PROVIDER_TYPE`.

### Annotations

The same file accepts an `annotations` map with free-form notes per model name. The list tool
shows these next to the models so Claude can weigh cost and quality when choosing:

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

## Development

```bash
pnpm dev        # run via tsx
pnpm typecheck  # tsc --noEmit
pnpm build      # compile to dist/
```
