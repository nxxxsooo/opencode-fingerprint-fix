import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
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
const ADAPTIVE_THINKING_MODELS = [
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
];
const DEFAULT_CONTEXT_MANAGEMENT = {
  edits: [{ type: "clear_thinking_20251015", keep: "all" }],
};
const CLAUDE_SESSION_ID = randomUUID();
const CLAUDE_DEVICE_ID = createHash("sha256")
  .update([
    "opencode-fingerprint-fix",
    process.env.USER ?? "",
    process.env.HOME ?? "",
  ].join("\0"))
  .digest("hex");

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

function supportsAdaptiveThinkingModel(id: string): boolean {
  return ADAPTIVE_THINKING_MODELS.some((model) => id.includes(model));
}

function isHaikuModel(id: string): boolean {
  return /haiku/i.test(id);
}

function providerOptionsFromConfig(config: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(config)) return undefined;
  const providers = config.provider;
  if (!isPlainRecord(providers)) return undefined;
  const anthropic = providers.anthropic;
  if (!isPlainRecord(anthropic)) return undefined;
  if (isPlainRecord(anthropic.options)) return anthropic.options;

  const options: Record<string, unknown> = {};
  anthropic.options = options;
  return options;
}

function installProviderFetch(config: unknown): void {
  const options = providerOptionsFromConfig(config);
  if (!options) return;
  options.fetch = fingerprintFetch;
}

function normalizeHeaderBag(headers: Headers): void {
  headers.delete("user-agent");
  headers.delete("User-Agent");
  headers.delete("accept");
  headers.delete("Accept");
  headers.set("User-Agent", USER_AGENT);
  headers.set("Accept", "application/json");
  headers.set("x-app", "cli");
  headers.set("anthropic-version", ANTHROPIC_VERSION);
  headers.set("anthropic-dangerous-direct-browser-access", "true");
  for (const [key, value] of Object.entries(STAINLESS_HEADERS)) {
    headers.set(key, value);
  }
  if (!headers.has("x-stainless-retry-count")) {
    headers.set("x-stainless-retry-count", "0");
  }
  if (!headers.has("x-stainless-timeout")) {
    headers.set("x-stainless-timeout", "600");
  }
  if (!headers.has("x-stainless-helper-method")) {
    headers.set("x-stainless-helper-method", "stream");
  }
  if (!headers.has("x-client-request-id")) {
    headers.set("x-client-request-id", randomUUID());
  }
  headers.set("x-claude-code-session-id", CLAUDE_SESSION_ID);
  headers.set("anthropic-beta", buildBetaFlags(headers.get("anthropic-beta") || ""));
}

function normalizeHeaderRecord(headers: Record<string, string>): void {
  const bag = new Headers(headers);
  normalizeHeaderBag(bag);
  for (const key of Object.keys(headers)) {
    delete headers[key];
  }
  bag.forEach((value, key) => {
    headers[key] = value;
  });
}

function mergeHeaders(target: Headers, source: HeadersInit | undefined): void {
  if (!source) return;
  if (source instanceof Headers) {
    source.forEach((value, key) => target.set(key, value));
    return;
  }
  if (Array.isArray(source)) {
    for (const [key, value] of source) {
      target.set(key, value);
    }
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) target.set(key, String(value));
  }
}

function requestUrl(input: string | URL | Request): URL | undefined {
  try {
    if (input instanceof Request) return new URL(input.url);
    return new URL(input.toString());
  } catch {
    return undefined;
  }
}

function transformRequestUrl(input: string | URL | Request): string | URL | Request {
  const url = requestUrl(input);
  if (!url) return input;
  if (url.pathname === "/messages") {
    url.pathname = "/v1/messages";
  }
  if (
    (url.pathname === "/v1/messages" ||
      url.pathname === "/v1/messages/count_tokens") &&
    !url.searchParams.has("beta")
  ) {
    url.searchParams.set("beta", "true");
  }
  return url.toString();
}

function effortFromBudget(value: unknown): string {
  if (typeof value !== "number") return "medium";
  if (value <= 1024) return "low";
  if (value <= 8000) return "medium";
  return "high";
}

function thinkingType(value: unknown): string | undefined {
  if (!isPlainRecord(value)) return undefined;
  return typeof value.type === "string" ? value.type : undefined;
}

function normalizeManualThinkingBudget(body: Record<string, unknown>): void {
  const thinking = isPlainRecord(body.thinking) ? body.thinking : undefined;
  if (!thinking || thinking.type !== "enabled") return;
  const budget = thinking.budget_tokens ?? thinking.budgetTokens;
  if (typeof budget === "number") {
    thinking.budget_tokens = budget;
  }
  if (Object.hasOwn(thinking, "budgetTokens")) {
    delete thinking.budgetTokens;
  }
}

function normalizeThinking(body: Record<string, unknown>): void {
  const id = typeof body.model === "string" ? body.model : "";
  const haiku = isHaikuModel(id);
  if (haiku) {
    delete body.thinking;
    delete body.context_management;
    delete body.effort;
  }
  const adaptive = supportsAdaptiveThinkingModel(id);
  if (!body.thinking && adaptive) {
    body.thinking = { type: "adaptive" };
  }
  normalizeManualThinkingBudget(body);

  const type = thinkingType(body.thinking);
  if ((type === "enabled" || type === "adaptive") && adaptive) {
    const current = isPlainRecord(body.thinking) ? body.thinking : {};
    const outputConfig = isPlainRecord(body.output_config) ? body.output_config : {};
    const existingEffort = outputConfig.effort ?? current.effort ?? body.effort;
    outputConfig.effort =
      typeof existingEffort === "string"
        ? existingEffort
        : effortFromBudget(current.budget_tokens ?? current.budgetTokens);
    body.output_config = outputConfig;
    body.thinking = { type: "adaptive" };
  }

  if (!adaptive && Object.hasOwn(body, "effort")) {
    delete body.effort;
  }

  if (haiku && isPlainRecord(body.output_config) && "effort" in body.output_config) {
    const { effort: _effort, ...rest } = body.output_config;
    if (Object.keys(rest).length > 0) {
      body.output_config = rest;
    } else {
      delete body.output_config;
    }
  }

  const normalizedType = thinkingType(body.thinking);
  if (normalizedType === "enabled" || normalizedType === "adaptive") {
    delete body.temperature;
    if (!body.context_management) {
      body.context_management = DEFAULT_CONTEXT_MANAGEMENT;
    }
  }
}

function buildMetadataUserID(): string {
  return JSON.stringify({
    device_id: CLAUDE_DEVICE_ID,
    account_uuid: "",
    session_id: CLAUDE_SESSION_ID,
  });
}

function normalizeMetadata(body: Record<string, unknown>): void {
  const metadata = isPlainRecord(body.metadata) ? body.metadata : {};
  const userID = metadata.user_id;
  if (typeof userID !== "string" || userID.trim() === "") {
    metadata.user_id = buildMetadataUserID();
  }
  body.metadata = metadata;
}

function compactHaikuRequest(body: Record<string, unknown>): void {
  const id = typeof body.model === "string" ? body.model : "";
  if (!isHaikuModel(id)) return;

  delete body.tools;
  delete body.tool_choice;

  const blocks = normalizeSystemBlocks(body.system);
  const compactBlocks = blocks.filter((block) => {
    const text = systemBlockText(block);
    return (
      text.startsWith("x-anthropic-billing-header:") ||
      text.includes(CLAUDE_PREFIX)
    );
  });
  body.system = compactBlocks.length > 0
    ? compactBlocks
    : [{ type: "text", text: CLAUDE_PREFIX }];

  if (typeof body.max_tokens === "number" && body.max_tokens > 2048) {
    body.max_tokens = 2048;
  }
}

function systemBlockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (!isPlainRecord(block)) return "";
  return typeof block.text === "string" ? block.text : "";
}

function normalizeSystemBlocks(system: unknown): Record<string, unknown>[] {
  const items = Array.isArray(system) ? system : system ? [system] : [];
  return items.map((item) => {
    if (typeof item === "string") {
      return { type: "text", text: sanitizeSystemText(item) };
    }
    if (isPlainRecord(item) && typeof item.text === "string") {
      return { ...item, text: sanitizeSystemText(item.text) };
    }
    return isPlainRecord(item) ? item : { type: "text", text: "" };
  });
}

function normalizeBodyText(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isPlainRecord(parsed)) return text;
    delete parsed.betas;

    normalizeMetadata(parsed);
    normalizeThinking(parsed);

    const blocks = normalizeSystemBlocks(parsed.system);
    const texts = blocks.map(systemBlockText);
    const hasBilling = texts.some((item) =>
      item.startsWith("x-anthropic-billing-header:"),
    );
    const hasClaudePrefix = texts.some((item) => item.includes(CLAUDE_PREFIX));
    const injected: Record<string, unknown>[] = [];
    if (!hasBilling) {
      injected.push({ type: "text", text: billingHeader(texts) });
    }
    if (!hasClaudePrefix) {
      injected.push({ type: "text", text: CLAUDE_PREFIX });
    }
    parsed.system = [...injected, ...blocks];
    compactHaikuRequest(parsed);

    return JSON.stringify(parsed);
  } catch {
    return text;
  }
}

async function bodyText(input: string | URL | Request, init?: RequestInit) {
  if (typeof init?.body === "string") return init.body;
  if (init?.body instanceof Uint8Array) {
    return new TextDecoder().decode(init.body);
  }
  if (input instanceof Request && !init?.body) {
    try {
      return await input.clone().text();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function bodySummary(text: string | undefined): Record<string, unknown> {
  if (!text) return { hasBody: false };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isPlainRecord(parsed)) return { hasBody: true, json: false };
    const thinking = isPlainRecord(parsed.thinking) ? parsed.thinking : undefined;
    const outputConfig = isPlainRecord(parsed.output_config)
      ? parsed.output_config
      : undefined;
    const metadata = isPlainRecord(parsed.metadata) ? parsed.metadata : undefined;
    const messages = Array.isArray(parsed.messages) ? parsed.messages : undefined;
    const tools = Array.isArray(parsed.tools) ? parsed.tools : undefined;
    const blocks = normalizeSystemBlocks(parsed.system);
    const texts = blocks.map(systemBlockText);
    return {
      hasBody: true,
      json: true,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      topLevelKeys: Object.keys(parsed).sort(),
      maxTokens: parsed.max_tokens,
      stream: parsed.stream,
      messagesCount: messages?.length,
      toolsCount: tools?.length,
      hasToolChoice: Object.hasOwn(parsed, "tool_choice"),
      hasBetas: Object.hasOwn(parsed, "betas"),
      hasTemperature: Object.hasOwn(parsed, "temperature"),
      hasThinking: Boolean(thinking),
      thinkingType: thinkingType(thinking),
      thinkingBudget: thinking?.budget_tokens ?? thinking?.budgetTokens,
      hasContextManagement: Object.hasOwn(parsed, "context_management"),
      outputConfigKeys: outputConfig ? Object.keys(outputConfig).sort() : [],
      hasMetadata: Boolean(metadata),
      hasMetadataUserID: typeof metadata?.user_id === "string",
      systemBlocks: blocks.length,
      systemTextChars: texts.reduce((total, item) => total + item.length, 0),
      hasBilling: texts.some((item) =>
        item.startsWith("x-anthropic-billing-header:"),
      ),
      hasClaudePrefix: texts.some((item) => item.includes(CLAUDE_PREFIX)),
    };
  } catch {
    return { hasBody: true, json: false };
  }
}

function debugFingerprint(
  url: string | URL | Request,
  headers: Headers,
  text: string | undefined,
): void {
  const path = process.env.OPENCODE_FINGERPRINT_FIX_DEBUG;
  if (!path) return;

  const target = requestUrl(url);
  const event = {
    timestamp: new Date().toISOString(),
    url: target?.toString() ?? String(url),
    headers: {
      userAgent: headers.get("user-agent"),
      app: headers.get("x-app"),
      anthropicVersion: headers.get("anthropic-version"),
      anthropicBeta: headers.get("anthropic-beta"),
      stainlessRuntime: headers.get("x-stainless-runtime"),
      hasClaudeCodeSessionID: headers.has("x-claude-code-session-id"),
      hasAuthorization: headers.has("authorization"),
      hasApiKey: headers.has("x-api-key"),
    },
    body: bodySummary(text),
  };

  try {
    appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  } catch (error) {
    if (error instanceof Error) return;
    return;
  }
}

type FetchFunction = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function shouldFingerprint(input: string | URL | Request): boolean {
  const url = requestUrl(input);
  if (!url) return false;
  return (
    url.pathname === "/messages" ||
    url.pathname === "/v1/messages" ||
    url.pathname === "/v1/messages/count_tokens"
  );
}

async function fingerprintFetchWith(
  baseFetch: FetchFunction,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  mergeHeaders(headers, init?.headers);
  normalizeHeaderBag(headers);

  const text = await bodyText(input, init);
  const nextInit: RequestInit = { ...init, headers };
  if (input instanceof Request && !nextInit.method) {
    nextInit.method = input.method;
  }
  if (text !== undefined) {
    nextInit.body = normalizeBodyText(text);
  }

  const nextUrl = transformRequestUrl(input);
  debugFingerprint(
    nextUrl,
    headers,
    typeof nextInit.body === "string" ? nextInit.body : undefined,
  );
  return baseFetch(nextUrl, nextInit);
}

let baseGlobalFetch: FetchFunction | undefined;

async function fingerprintFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return fingerprintFetchWith(baseGlobalFetch ?? fetch, input, init);
}

let restoreFetch: (() => void) | undefined;

function installGlobalFetchWrapper(): (() => void) | undefined {
  if (restoreFetch) return restoreFetch;
  if (typeof globalThis.fetch !== "function") return undefined;
  const baseFetch = globalThis.fetch.bind(globalThis) as FetchFunction;
  baseGlobalFetch = baseFetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (shouldFingerprint(input)) {
      return fingerprintFetchWith(baseFetch, input, init);
    }
    return baseFetch(input, init);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = baseFetch as typeof fetch;
    baseGlobalFetch = undefined;
    restoreFetch = undefined;
  };
  return restoreFetch;
}

// ── Plugin ─────────────────────────────────────────────────────────

const OpenCodeFingerprintFix = () => {
  const restoreGlobalFetch = installGlobalFetchWrapper();

  return {
    dispose: async () => {
      restoreGlobalFetch?.();
    },

    config: async (input: unknown) => {
      installProviderFetch(input);
    },

    auth: {
      provider: "anthropic",
      loader: async () => ({
        fetch: fingerprintFetch,
      }),
      methods: [],
    },

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

      normalizeHeaderRecord(output.headers);
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

      if (!output.options.thinking && supportsAdaptiveThinkingModel(id)) {
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
