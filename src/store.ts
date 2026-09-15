import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StoredSession {
  // Stable logical name given by the caller, e.g. "my-app:reviewer".
  name: string;
  // Copilot session UUID; passed back via --session-id to resume.
  copilotSessionId: string;
  workdir: string;
  model: string | null;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
  lastPrompt: string;
}

interface StoreFile {
  sessions: Record<string, StoredSession>;
}

const STATE_DIR = join(homedir(), ".copilot-mcp");
const STATE_FILE = join(STATE_DIR, "sessions.json");

function load(): StoreFile {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<StoreFile>;
    return { sessions: parsed.sessions ?? {} };
  } catch {
    return { sessions: {} };
  }
}

function save(store: StoreFile): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, STATE_FILE);
}

export function getSession(name: string): StoredSession | undefined {
  return load().sessions[name];
}

export function putSession(session: StoredSession): void {
  const store = load();
  store.sessions[session.name] = session;
  save(store);
}

export function removeSession(name: string): boolean {
  const store = load();
  const existed = name in store.sessions;
  if (existed) {
    delete store.sessions[name];
    save(store);
  }
  return existed;
}

export function listSessions(): StoredSession[] {
  return Object.values(load().sessions).sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}
