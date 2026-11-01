import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CopilotCallResult } from "./copilot.js";

// Local review ledger. One directory per attempt, so several bridge processes can write
// at once without locks:
//   ~/.copilot-mcp/ledger/attempts/<id>/start.json     written before Copilot launches
//   ~/.copilot-mcp/ledger/attempts/<id>/end.json       missing means the run was interrupted
//   ~/.copilot-mcp/ledger/attempts/<id>/triage-*.json  the calling agent's opinion
// Prompts, responses and the reviewed patch sit next to them, after best-effort scrubbing.

const SCHEMA_VERSION = 1;
const GIT_TIMEOUT_MS = 10_000;
const MAX_DIFF_BYTES = 20 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 256 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 5 * 1024 * 1024;

// Files that must never reach the ledger, whatever their content looks like.
const SECRET_FILE = /(^|\/)(\.env[^/]*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa[^/]*|id_ed25519[^/]*)$/;
const SECRET_PATHSPECS = [
  ":(glob,exclude)**/.env*",
  ":(glob,exclude)**/*.pem",
  ":(glob,exclude)**/*.key",
  ":(glob,exclude)**/*.p12",
  ":(glob,exclude)**/*.pfx",
  ":(glob,exclude)**/id_rsa*",
  ":(glob,exclude)**/id_ed25519*",
];

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]"],
  [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[REDACTED]"],
  [
    /((?:api[_-]?key|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
    "$1[REDACTED]",
  ],
];

export function scrub(text: string): string {
  return SECRET_PATTERNS.reduce((out, [pattern, swap]) => out.replace(pattern, swap), text);
}

// Read at call time, so a changed HOME is honored the same way as in store.ts.
function ledgerDir(): string {
  return join(homedir(), ".copilot-mcp", "ledger");
}

function attemptDir(id: string): string {
  return join(ledgerDir(), "attempts", id);
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

function writeJson(path: string, value: unknown): void {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function git(cwd: string, args: string[], maxBuffer = 1024 * 1024): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer, encoding: "utf8" },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

export interface TargetIdentity {
  // "git" when the snapshot was taken, "none" outside a repo, "unavailable" when git failed.
  kind: "git" | "none" | "unavailable";
  repo: string | null;
  branch: string | null;
  head: string | null;
  // Hash over the raw patch and untracked content, so equal hashes mean equal reviewed content.
  // It deliberately does not match target.patch, which is scrubbed before it is stored.
  sha256: string | null;
  patchBytes: number;
  untrackedFiles: number;
  untrackedSkipped: number;
}

interface TargetSnapshot {
  identity: TargetIdentity;
  patch: string;
}

const EMPTY_TARGET = {
  repo: null,
  branch: null,
  head: null,
  sha256: null,
  patchBytes: 0,
  untrackedFiles: 0,
  untrackedSkipped: 0,
};

async function captureTarget(workdir: string): Promise<TargetSnapshot> {
  const inside = await git(workdir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") {
    return { identity: { kind: "none", ...EMPTY_TARGET }, patch: "" };
  }
  const root = (await git(workdir, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!root) return { identity: { kind: "unavailable", ...EMPTY_TARGET }, patch: "" };

  const head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]))?.trim() || null;
  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() || null;
  const diff = head
    ? await git(
        root,
        ["diff", "HEAD", "--no-ext-diff", "--no-textconv", "--", ".", ...SECRET_PATHSPECS],
        MAX_DIFF_BYTES,
      )
    : "";
  const listed = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], MAX_DIFF_BYTES);
  if (diff === null || listed === null) {
    return {
      identity: { kind: "unavailable", ...EMPTY_TARGET, repo: basename(root), branch, head },
      patch: "",
    };
  }

  const parts = [diff];
  let total = 0;
  let included = 0;
  let skipped = 0;
  for (const file of listed.split("\0").filter(Boolean)) {
    const path = join(root, file);
    try {
      const stat = lstatSync(path);
      const tooBig =
        stat.size > MAX_UNTRACKED_FILE_BYTES || total + stat.size > MAX_UNTRACKED_TOTAL_BYTES;
      if (!stat.isFile() || SECRET_FILE.test(file) || tooBig) {
        skipped++;
        continue;
      }
      const content = readFileSync(path);
      if (content.includes(0)) {
        skipped++;
        continue;
      }
      total += stat.size;
      included++;
      parts.push(`\n--- untracked: ${file}\n${content.toString("utf8")}`);
    } catch {
      skipped++;
    }
  }

  const patch = parts.join("");
  return {
    identity: {
      kind: "git",
      repo: basename(root),
      branch,
      head,
      sha256: sha256(patch),
      patchBytes: Buffer.byteLength(patch),
      untrackedFiles: included,
      untrackedSkipped: skipped,
    },
    patch,
  };
}

function classifyError(result: CopilotCallResult): string | null {
  const source = result.sessionError
    ? `${result.sessionError.type} ${result.sessionError.message}`
    : result.exitCode === 0
      ? ""
      : result.stderr;
  if (!source) return null;
  if (/quota|rate.?limit|too many requests|\b429\b/i.test(source)) return "quota";
  if (/unauthori[sz]ed|authenticat|\blogin\b|\b401\b|\b403\b/i.test(source)) return "auth";
  if (/model/i.test(source) && /not |unavailable|unsupported|invalid/i.test(source)) {
    return "model_unavailable";
  }
  return "other";
}

export interface AttemptMeta {
  session: string;
  workdir: string;
  client: { name: string; version: string } | null;
  priorTurns: number;
  copilotSessionId: string | null;
  prompt: string;
  requestedModel: string | null;
  effort: string | null;
  timeoutMs: number | null;
  allowTools: string[];
  addDirs: string[];
  attachments: string[];
  reviewKind: string | null;
  episode: string | null;
  pass: string | null;
  author: string | null;
}

export interface Attempt {
  // Null when the ledger could not record this attempt; the review still runs.
  id: string | null;
  warning: string | null;
  finish(result: CopilotCallResult): Promise<void>;
  fail(error: unknown): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Never throws: a broken ledger must not cost a review, but its failure stays visible.
export async function beginAttempt(meta: AttemptMeta): Promise<Attempt> {
  const startedAt = new Date();
  const id = randomUUID();
  const dir = attemptDir(id);
  let target: TargetIdentity | null = null;

  const attempt: Attempt = {
    id,
    warning: null,

    async finish(result) {
      if (attempt.id === null) return;
      try {
        const before = target?.sha256 ?? null;
        const after = before ? (await captureTarget(meta.workdir)).identity.sha256 : null;
        // Null when either snapshot is missing: a git outage is not a changed target.
        const changed = before && after ? before !== after : null;
        if (result.text) writeAtomic(join(dir, "response.txt"), scrub(result.text));
        if (result.finalText) writeAtomic(join(dir, "final.txt"), scrub(result.finalText));

        const interrupted = result.timedOut || result.aborted || result.exitCode !== 0;
        const failed = interrupted || result.sessionError !== null;
        writeJson(join(dir, "end.json"), {
          schemaVersion: SCHEMA_VERSION,
          id,
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          execution: result.aborted
            ? "cancelled"
            : result.timedOut
              ? "timed_out"
              : failed
                ? "failed"
                : "completed",
          response: !result.text ? "empty" : failed ? "partial" : "complete",
          exitCode: result.exitCode,
          errorClass: classifyError(result),
          errorMessage: result.sessionError ? scrub(result.sessionError.message) : null,
          observedModel: result.model,
          copilotSessionId: result.sessionId,
          // Null means Copilot reported no usage, which is not the same as zero.
          premiumRequests: result.premiumRequestsReported ? result.premiumRequests : null,
          filesModified: result.filesModified,
          responseChars: result.text.length,
          finalChars: result.finalText.length,
          targetChangedDuringRun: changed,
        });
      } catch (err) {
        attempt.warning = `review ledger could not record the result: ${errorMessage(err)}`;
      }
    },

    fail(error) {
      if (attempt.id === null) return;
      try {
        writeJson(join(dir, "end.json"), {
          schemaVersion: SCHEMA_VERSION,
          id,
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          execution: "spawn_failed",
          response: "empty",
          exitCode: null,
          errorClass: "other",
          errorMessage: scrub(errorMessage(error)),
          observedModel: null,
          copilotSessionId: null,
          premiumRequests: null,
          filesModified: [],
          responseChars: 0,
          finalChars: 0,
          targetChangedDuringRun: null,
        });
      } catch {
        // The caller already sees the spawn error; a missing end.json reads as interrupted.
      }
    },
  };

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const snapshot = await captureTarget(meta.workdir);
    target = snapshot.identity;
    writeAtomic(join(dir, "prompt.txt"), scrub(meta.prompt));
    if (snapshot.patch) writeAtomic(join(dir, "target.patch"), scrub(snapshot.patch));
    writeJson(join(dir, "start.json"), {
      schemaVersion: SCHEMA_VERSION,
      id,
      startedAt: startedAt.toISOString(),
      client: meta.client,
      session: meta.session,
      project: meta.session.split(":")[0],
      workdir: meta.workdir,
      priorTurns: meta.priorTurns,
      copilotSessionId: meta.copilotSessionId,
      requestedModel: meta.requestedModel,
      effort: meta.effort,
      timeoutMs: meta.timeoutMs,
      allowTools: meta.allowTools,
      addDirs: meta.addDirs,
      attachments: meta.attachments,
      reviewKind: meta.reviewKind,
      episode: meta.episode,
      pass: meta.pass,
      // Declared by the caller. The bridge cannot verify who wrote the reviewed work.
      author: meta.author ? { model: meta.author, source: "caller-declared" } : null,
      promptSha256: sha256(meta.prompt),
      promptChars: meta.prompt.length,
      target: snapshot.identity,
    });
  } catch (err) {
    attempt.id = null;
    attempt.warning = `review ledger could not record this attempt: ${errorMessage(err)}`;
  }
  return attempt;
}

export interface TriageFinding {
  claim: string;
  reviewerSeverity?: string;
  disposition: string;
  note?: string;
}

export interface TriageInput {
  attemptId: string;
  findings: TriageFinding[];
  decisionsChanged?: string[];
  planBefore?: string;
  planAfter?: string;
  note?: string;
  client: { name: string; version: string } | null;
}

// Appends a triage record; returns false when the attempt id is unknown.
export function recordTriage(input: TriageInput): boolean {
  const dir = attemptDir(input.attemptId);
  if (!existsSync(join(dir, "start.json"))) return false;
  writeJson(join(dir, `triage-${Date.now()}-${randomUUID()}.json`), {
    schemaVersion: SCHEMA_VERSION,
    attemptId: input.attemptId,
    recordedAt: new Date().toISOString(),
    // An agent judging feedback on its own work: useful for triage, never ground truth.
    source: "implementing-agent-opinion",
    client: input.client,
    findings: input.findings.map((f) => ({
      claim: scrub(f.claim),
      reviewerSeverity: f.reviewerSeverity ?? null,
      disposition: f.disposition,
      note: f.note ? scrub(f.note) : null,
    })),
    decisionsChanged: input.decisionsChanged?.map(scrub) ?? null,
    planBefore: input.planBefore ? scrub(input.planBefore) : null,
    planAfter: input.planAfter ? scrub(input.planAfter) : null,
    note: input.note ? scrub(input.note) : null,
  });
  return true;
}
