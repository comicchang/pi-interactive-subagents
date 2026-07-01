/**
 * oh-my-pi (omp) compatibility layer.
 *
 * When running inside oh-my-pi (omp), the `pi` binary may not exist and
 * agent definitions live in ~/.omp/agent/agents/ instead of
 * ~/.pi/agent/agents/. This module resolves the correct agent config
 * directory and maps CLI arguments between pi and omp formats.
 *
 * Design goals:
 *   - index.ts calls the exported functions at integration points.
 *   - CLI args are mapped based on which agent config dir is active.
 *   - Zero behavioural change when only ~/.pi/agent exists.
 *   - PI_CODING_AGENT_DIR / PI_SUBAGENT_CLI env vars always take priority.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";

// ── Agent config directory ───────────────────────────────────────────────────

const ompAgentDir = join(homedir(), ".omp", "agent");
const piAgentDir = join(homedir(), ".pi", "agent");

/**
 * Resolve the agent config directory.
 *
 * Priority:
 *   1. PI_CODING_AGENT_DIR env var (explicit override)
 *   2. ~/.omp/agent (oh-my-pi environment — checked first)
 *   3. ~/.pi/agent (original default)
 */
export function resolveAgentConfigDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (envDir) return envDir;
  if (existsSync(ompAgentDir)) return ompAgentDir;
  return piAgentDir;
}

// ── CLI binary name ──────────────────────────────────────────────────────────

/**
 * Derive the default CLI binary name from the active agent config directory.
 *
 * PI_SUBAGENT_CLI env var takes priority when set.
 * Otherwise the parent directory name of the config dir is used
 * (e.g. ~/.omp/agent → "omp", ~/.pi/agent → "pi").
 */
export function resolveDefaultCli(): string {
  const envCli = process.env.PI_SUBAGENT_CLI?.trim();
  if (envCli) return envCli;
  const configDir = resolveAgentConfigDir();
  return basename(dirname(configDir)).replace(/^\./, "");
}

// ── CLI argument mapping ─────────────────────────────────────────────────────

export interface SessionArgs {
  /** CLI arguments for session handling. */
  args: string[];
  /**
   * When non-null, the CLI uses --session-dir instead of --session.
   * After the process exits, call findLatestSessionFile(sessionDir)
   * to locate the actual session file omp created.
   */
  sessionDir: string | null;
}

/**
 * CLI argument mapping between pi and omp.
 *
 * pi uses `--session <file.jsonl>` to specify a session file.
 * omp uses `--session-dir <dir>` + `--auto-approve -p`:
 *   - `--session-dir` lets omp create its own session file in the dir
 *   - `--auto-approve` skips interactive tool approval
 *   - `-p` (print mode) ensures the process exits after the agent responds
 *
 * The `-p` flag is critical: without it, omp stays in interactive mode
 * and the plugin can't detect completion or extract results.
 */
export function buildSessionArgs(cli: string, sessionFile: string): SessionArgs {
  if (cli === "omp") {
    const dir = dirname(sessionFile);
    return {
      args: ["--session-dir", dir, "--auto-approve", "-p"],
      sessionDir: dir,
    };
  }
  return {
    args: ["--session", sessionFile],
    sessionDir: null,
  };
}

/**
 * Find the most recently created .jsonl session file in a directory.
 * Used after an omp subagent exits with `-p` mode, since omp creates
 * its own session file with a timestamp-based name.
 *
 * With `-p` mode the process exits immediately after the agent responds,
 * so the newest .jsonl in the directory is guaranteed to be the one from
 * this run (each subagent gets its own session directory).
 *
 * Returns the full path, or null if no .jsonl files are found.
 * Excludes `excludePath` (the plugin's own placeholder file).
 */
export function findLatestSessionFile(sessionDir: string, excludePath?: string): string | null {
  if (!existsSync(sessionDir)) return null;
  let latest: { path: string; mtime: number } | null = null;
  for (const entry of readdirSync(sessionDir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const fullPath = join(sessionDir, entry);
    if (fullPath === excludePath) continue;
    try {
      const stat = statSync(fullPath);
      if (!latest || stat.mtimeMs > latest.mtime) {
        latest = { path: fullPath, mtime: stat.mtimeMs };
      }
    } catch {
      // ignore unreadable files
    }
  }
  return latest?.path ?? null;
}
