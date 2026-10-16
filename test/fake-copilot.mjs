#!/usr/bin/env node
// Stand-in for the Copilot CLI. Behaviour is driven by the prompt text; argv is
// appended to $FAKE_COPILOT_LOG so tests can assert on the flags the bridge passes.
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_COPILOT_LOG) {
  appendFileSync(process.env.FAKE_COPILOT_LOG, JSON.stringify(argv) + "\n");
}

if (argv[0] === "--version") {
  console.log("GitHub Copilot CLI 9.9.9.");
  process.exit(0);
}
if (argv[0] === "help" && argv[1] === "config") {
  console.log(
    [
      "Configuration Settings:",
      "",
      "  `mouse`: whether to enable mouse support.",
      "",
      "  `model`: AI model to use for Copilot CLI.",
      '    - "fake-model-a"',
      '    - "fake-model-b"',
      "",
      "  `stream`: whether to enable streaming mode.",
    ].join("\n"),
  );
  process.exit(0);
}

const prompt = argv[argv.indexOf("-p") + 1];
const sessionId = argv[argv.indexOf("--session-id") + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

if (prompt === "fail") {
  process.stderr.write("Error: Access denied by policy settings\n");
  process.exit(1);
}

emit({ type: "session.start", data: {} });
emit({ type: "tool.execution_start", data: { toolName: "view" } });
emit({ type: "assistant.message", data: { content: `echo: ${prompt}`, model: "fake-model-a" } });

if (prompt === "hang") {
  setInterval(() => {}, 1_000);
} else {
  emit({
    type: "result",
    sessionId,
    usage: { premiumRequests: 1, codeChanges: { filesModified: [] } },
  });
}
