import { createHash, randomUUID } from "node:crypto";
import {
  BETA_FLAGS,
  CLI_VERSION,
  STAINLESS_HEADERS,
  USER_AGENT,
  ANTHROPIC_VERSION,
} from "./constants.js";

// ── Helpers ────────────────────────────────────────────────────────

const CLAUDE_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/** Build deduplicated beta flags string. */
function buildBetaFlags(existing: string): string {
  const incoming = existing.split(",").map((b) => b.trim()).filter(Boolean);
  const required = BETA_FLAGS.split(",").map((b) => b.trim());
  return [...new Set([...required, ...incoming])].join(",");
}

function buildBetaList(existing: unknown): string[] {
  const current = Array.isArray(existing)
    ? existing.filter((item): item is string => typeof item === "string")
    : typeof existing === "string"
      ? existing.split(",").map((item) => item.trim()).filter(Boolean)
      : [];
  const required = BETA_FLAGS.split(",").map((item) => item.trim()).filter(Boolean);
  return [...new Set([...required, ...current])];
}

/** Deduplicate repeated Claude Code prefix in a text block. */
function deduplicatePrefix(text: string): string {
  const doubled = `${CLAUDE_PREFIX}\n\n${CLAUDE_PREFIX}`;
  while (text.includes(doubled)) {
    text = text.replace(doubled, CLAUDE_PREFIX);
  }
  return text;
}

function sanitizeSystemText(text: string): string {
  return deduplicatePrefix(
    text
      .replace(/OpenCode/g, "Claude Code")
      .replace(/opencode/gi, "Claude"),
  );
}

function billingHeader(system: string[]): string {
  const sysContent = system.join("");
  const hash = createHash("sha256").update(sysContent).digest("hex");
  return `x-anthropic-billing-header: cc_version=${CLI_VERSION}.${hash.slice(0, 3)}; cc_entrypoint=cli; cch=${hash.slice(0, 5)};`;
}

function modelID(model?: {
  modelID?: string;
  id?: string;
  api?: { id?: string };
}): string {
  return model?.modelID || model?.id || model?.api?.id || "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeAnthropicBetas(options: Record<string, unknown>): void {
  options.anthropicBeta = buildBetaList(options.anthropicBeta);

  const nested = isPlainRecord(options.anthropic) ? options.anthropic : {};
  nested.anthropicBeta = buildBetaList(nested.anthropicBeta);
  options.anthropic = nested;
}

// ── Plugin ─────────────────────────────────────────────────────────

const OpenCodeFingerprintFix = () => {
  return {
    /**
     * Rewrite the system prompt so Anthropic sees Claude Code identity
     * instead of OpenCode identity. This is the key fingerprint fix.
     */
    "experimental.chat.system.transform": (
      input: { model?: { providerID: string } },
      output: { system: string[] },
    ) => {
      if (input.model?.providerID !== "anthropic") return;

      output.system = output.system.map(sanitizeSystemText);
      const hasClaudePrefix = output.system.some((s) => s.includes(CLAUDE_PREFIX));
      const hasBilling = output.system.some((s) =>
        s.includes("x-anthropic-billing-header:"),
      );
      const prefix = hasClaudePrefix ? [] : [CLAUDE_PREFIX];
      const billing = hasBilling ? [] : [billingHeader(output.system)];
      const injected = [...prefix, ...billing].join("\n\n");

      if (!injected) return;
      if (output.system.length > 0) {
        output.system[0] = `${injected}\n\n${output.system[0]}`;
      } else {
        output.system.push(injected);
      }
    },

    /**
     * Rewrite request headers for Claude Code
     * fingerprint compatibility. Works with any auth method (API key,
     * proxy, Sub2API) — does NOT manage credentials.
     */
    "chat.headers": (
      input: { model?: { providerID: string } },
      output: { headers: Record<string, string> },
    ) => {
      if (input.model?.providerID !== "anthropic") return;

      delete output.headers["user-agent"];
      delete output.headers["User-Agent"];
      delete output.headers["accept"];
      delete output.headers["Accept"];

      output.headers["User-Agent"] = USER_AGENT;
      output.headers["Accept"] = "application/json";
      output.headers["x-app"] = "cli";
      output.headers["anthropic-version"] = ANTHROPIC_VERSION;
      output.headers["anthropic-dangerous-direct-browser-access"] = "true";
      for (const [k, v] of Object.entries(STAINLESS_HEADERS)) {
        output.headers[k] = v;
      }
      if (!output.headers["x-stainless-retry-count"]) {
        output.headers["x-stainless-retry-count"] = "0";
      }
      if (!output.headers["x-stainless-timeout"]) {
        output.headers["x-stainless-timeout"] = "600";
      }
      if (!output.headers["x-stainless-helper-method"]) {
        output.headers["x-stainless-helper-method"] = "stream";
      }
      if (!output.headers["x-client-request-id"]) {
        output.headers["x-client-request-id"] = randomUUID();
      }
      output.headers["anthropic-beta"] = buildBetaFlags(
        output.headers["anthropic-beta"] || "",
      );
    },

    /**
     * Rewrite provider options through OpenCode's supported hook surface.
     * OpenCode has no chat.body.transform hook, so provider-option mutations
     * need to happen here before the AI SDK serializes the Anthropic request.
     */
    "chat.params": (
      input: {
        model?: {
          providerID: string;
          modelID?: string;
          id?: string;
          api?: { id?: string };
        };
      },
      output: {
        temperature?: number;
        options: Record<string, unknown>;
      },
    ) => {
      if (input.model?.providerID !== "anthropic") return;

      const id = modelID(input.model);
      mergeAnthropicBetas(output.options);

      // Inject adaptive thinking for models that support it
      const ADAPTIVE_THINKING_MODELS = [
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-sonnet-4-6",
      ];
      const supportsAdaptiveThinking = ADAPTIVE_THINKING_MODELS.some((m) =>
        id.includes(m),
      );
      if (!output.options.thinking && supportsAdaptiveThinking) {
        output.options.thinking = { type: "adaptive" };
      }

      const thinkingType = (output.options.thinking as { type?: string })?.type;
      if (thinkingType === "enabled" || thinkingType === "adaptive") {
        delete output.temperature;
      }
    },
  };
};

export default OpenCodeFingerprintFix;
