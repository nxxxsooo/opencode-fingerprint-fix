import { createHash } from "node:crypto";
import {
  BETA_FLAGS,
  CLI_VERSION,
  STAINLESS_HEADERS,
  TOOL_PREFIX,
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

/** Deduplicate repeated Claude Code prefix in a text block. */
function deduplicatePrefix(text: string): string {
  const doubled = `${CLAUDE_PREFIX}\n\n${CLAUDE_PREFIX}`;
  while (text.includes(doubled)) {
    text = text.replace(doubled, CLAUDE_PREFIX);
  }
  return text;
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
      if (output.system.some((s) => s.includes(CLAUDE_PREFIX))) return;
      if (output.system.length > 0) {
        output.system[0] = `${CLAUDE_PREFIX}\n\n${output.system[0]}`;
      } else {
        output.system.push(CLAUDE_PREFIX);
      }
    },

    /**
     * Intercept fetch to rewrite headers, body, and URL for Claude Code
     * fingerprint compatibility. Works with any auth method (API key,
     * proxy, Sub2API) — does NOT manage credentials.
     */
    "chat.headers": (
      input: { model?: { providerID: string } },
      output: { headers: Record<string, string> },
    ) => {
      if (input.model?.providerID !== "anthropic") return;

      output.headers["user-agent"] = USER_AGENT;
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
      output.headers["anthropic-beta"] = buildBetaFlags(
        output.headers["anthropic-beta"] || "",
      );
    },

    /**
     * Rewrite the request body: inject billing header, sanitize system
     * prompt, prefix tool names, add thinking for supported models,
     * append ?beta=true to URL.
     */
    "chat.body.transform": (
      input: { model?: { providerID: string; modelID?: string } },
      output: {
        body: Record<string, unknown>;
        url?: string;
      },
    ) => {
      if (input.model?.providerID !== "anthropic") return;

      const body = output.body;
      const modelID = input.model?.modelID || "";

      // Inject billing header as first system block
      if (!body.system) body.system = [];
      const sysArray = body.system as Array<{ text?: string; type?: string }>;
      const hasBilling = sysArray.some(
        (s) => s.text?.startsWith("x-anthropic-billing-header:"),
      );
      if (!hasBilling) {
        const sysContent = sysArray
          .map((s) => s.text || "")
          .join("");
        const hash = createHash("sha256").update(sysContent).digest("hex");
        sysArray.unshift({
          type: "text",
          text: `x-anthropic-billing-header: cc_version=${CLI_VERSION}.${hash.slice(0, 3)}; cc_entrypoint=cli; cch=${hash.slice(0, 5)};`,
        });
      }

      // Sanitize system prompt — replace OpenCode references with Claude Code
      if (Array.isArray(body.system)) {
        body.system = (body.system as Array<{ type?: string; text?: string }>).map(
          (item) => {
            if (item.type === "text" && item.text) {
              return {
                ...item,
                text: deduplicatePrefix(
                  item.text
                    .replace(/OpenCode/g, "Claude Code")
                    .replace(/opencode/gi, "Claude"),
                ),
              };
            }
            return item;
          },
        );
      }

      // Prefix tool names with mcp_
      if (body.tools && Array.isArray(body.tools)) {
        body.tools = (body.tools as Array<{ name?: string }>).map(
          (tool) => ({
            ...tool,
            name:
              tool.name && !tool.name.startsWith(TOOL_PREFIX)
                ? `${TOOL_PREFIX}${tool.name}`
                : tool.name,
          }),
        );
      }

      // Prefix tool_use blocks in messages
      if (body.messages && Array.isArray(body.messages)) {
        for (const msg of body.messages as Array<{ content?: Array<{ type?: string; name?: string }> }>) {
          if (!Array.isArray(msg.content)) continue;
          for (const block of msg.content) {
            if (
              block.type === "tool_use" &&
              block.name &&
              !block.name.startsWith(TOOL_PREFIX)
            ) {
              block.name = `${TOOL_PREFIX}${block.name}`;
            }
          }
        }
      }

      // Haiku does NOT support thinking — strip it if present
      const isHaiku = modelID.toLowerCase().includes("haiku");
      if (isHaiku && body.thinking) {
        delete body.thinking;
      }

      // Inject adaptive thinking for models that support it
      const THINKING_MODELS = ["claude-opus-4", "claude-sonnet-4-6"];
      const supportsThinking = THINKING_MODELS.some((m) => modelID.includes(m));
      if (!body.thinking && supportsThinking) {
        body.thinking = { type: "adaptive" };
      }

      // Force temperature=1 when thinking is enabled
      const thinkingType = (body.thinking as { type?: string })?.type;
      if (
        (thinkingType === "enabled" || thinkingType === "adaptive") &&
        body.temperature !== undefined &&
        body.temperature !== 1
      ) {
        body.temperature = 1;
      }

      // Append ?beta=true to URL
      if (output.url) {
        try {
          const url = new URL(output.url);
          if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
            url.searchParams.set("beta", "true");
            output.url = url.toString();
          }
        } catch {}
      }
    },
  };
};

export default OpenCodeFingerprintFix;
