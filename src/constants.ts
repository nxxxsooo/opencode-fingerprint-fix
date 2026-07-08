import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function detectClaudeVersion(): string {
  try {
    const version = execSync("claude --version 2>/dev/null", {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    const match = version.match(/^(\d+\.\d+\.\d+)/);
    if (match) return match[1];
  } catch {}
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    const raw = readFileSync(credPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.version && typeof parsed.version === "string") return parsed.version;
  } catch {}
  return "2.1.81";
}

export const CLI_VERSION =
  process.env.ANTHROPIC_CLI_VERSION || detectClaudeVersion();

export const USER_AGENT =
  process.env.ANTHROPIC_USER_AGENT ||
  `claude-cli/${CLI_VERSION} (external, cli)`;

export const BETA_FLAGS =
  process.env.ANTHROPIC_BETA_FLAGS ||
  [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "effort-2025-11-24",
    "context-management-2025-06-27",
    "extended-cache-ttl-2025-04-11",
  ].join(",");

export const ANTHROPIC_VERSION = "2023-06-01";

export const STAINLESS_HEADERS: Record<string, string> = {
  "x-stainless-lang": "js",
  "x-stainless-package-version": process.env.ANTHROPIC_SDK_VERSION || "0.74.0",
  "x-stainless-os":
    process.platform === "darwin"
      ? "MacOS"
      : process.platform === "linux"
        ? "Linux"
        : "Windows",
  "x-stainless-arch": process.arch === "arm64" ? "arm64" : process.arch,
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": process.version,
};

export const TOOL_PREFIX = "mcp_";
