# opencode-fingerprint-fix

Small OpenCode plugin that rewrites Anthropic request metadata to match the Claude Code CLI request shape.

It does not implement auth, OAuth, token refresh, keychain access, account switching, or a proxy. It only transforms the request that OpenCode is already sending through your configured Anthropic-compatible provider, for example Sub2API.

## What It Changes

- Prepends a Claude Code identity line to the system prompt.
- Adds the Claude Code billing-header style system line.
- Replaces OpenCode references in system text with Claude Code references.
- Rewrites Anthropic request headers such as user agent, app marker, SDK/runtime headers, version, and beta flags.
- Adds Claude Code-style `x-claude-code-session-id` and `metadata.user_id` so Sub2API can rewrite the real account UUID/session metadata server-side.
- Adds the full Claude Code mimic beta set through Anthropic provider options.
- Wraps the Anthropic fetch call to rewrite final URL/body shape.
- Adds `?beta=true` to `/v1/messages` and `/v1/messages/count_tokens`.
- Removes `temperature` from thinking requests before the HTTP request is sent.
- Adds adaptive thinking only for Opus/Sonnet models that support adaptive thinking.
- Strips Haiku `thinking`, `context_management`, and `output_config.effort` in the OpenCode/Sub2API path.
- Compacts Haiku requests by removing OpenCode tool schemas/tool choice, trimming system text to Claude Code identity + billing, and capping `max_tokens` to 2048.

## Install From Source

```sh
git clone https://github.com/nxxxsooo/opencode-fingerprint-fix.git
cd opencode-fingerprint-fix
npm install
npm run build
```

Then add the built plugin path to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": [
    "/absolute/path/to/opencode-fingerprint-fix/dist/index.js"
  ]
}
```

Restart OpenCode after changing the plugin list.

## Notes

This plugin is meant for local compatibility testing with provider routes you control or are allowed to use. It does not provide credentials and does not bypass authentication.

Haiku can fail while Opus/Sonnet work for two separate reasons:

1. Some Sub2API Claude OAuth mimic paths historically treated Haiku differently from Sonnet/Opus. The relevant upstream fix is to apply the full Claude Code mimicry URL/header/body behavior to Haiku too.
2. OpenCode agent requests can be huge. A minimal Haiku request may work while a full OpenCode request with a massive system prompt and many tool schemas fails with Anthropic's "out of extra usage" error. This plugin therefore treats Haiku as a compact/lightweight path, not a full tool-agent path.

Anthropic's docs list Claude Haiku 4.5 as supporting manual extended thinking, but this plugin strips thinking for Haiku because the tested Sub2API OAuth account rejected the full OpenCode Haiku request shape while small non-thinking Haiku requests succeeded.

## Credits

Inspired by:

- [`ianjwhite99/opencode-with-claude`](https://github.com/ianjwhite99/opencode-with-claude), an OpenCode plugin for using Claude subscriptions through a local proxy.
- [`Wei-Shaw/sub2api` PR #2756](https://github.com/Wei-Shaw/sub2api/pull/2756) by `Wuxie233`, which documents and fixes the Haiku OAuth mimicry header/beta parity issue.
- [`Vacbo/opencode-anthropic-fix`](https://github.com/Vacbo/opencode-anthropic-fix), especially the Claude Code metadata/session fingerprinting shape.
- [`marco-jardim/opencode-anthropic-fix`](https://github.com/marco-jardim/opencode-anthropic-fix), especially the `metadata.user_id` account/session composition notes.
- [`dotCipher/opencode-claude-bridge`](https://github.com/dotCipher/opencode-claude-bridge), especially the fetch-layer request rewriting and session header behavior.

## License

MIT
