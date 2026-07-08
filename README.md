# opencode-fingerprint-fix

Small OpenCode plugin that rewrites Anthropic request metadata to match the Claude Code CLI request shape.

It does not implement auth, OAuth, token refresh, keychain access, account switching, or a proxy. It only transforms the request that OpenCode is already sending through your configured Anthropic-compatible provider, for example Sub2API.

## What It Changes

- Prepends a Claude Code identity line to the system prompt.
- Adds the Claude Code billing-header style system line.
- Replaces OpenCode references in system text with Claude Code references.
- Rewrites Anthropic request headers such as user agent, app marker, SDK/runtime headers, version, and beta flags.
- Adds the full Claude Code mimic beta set through Anthropic provider options.
- Adds adaptive thinking only for Opus/Sonnet models that support adaptive thinking.
- Omits `temperature` when thinking is enabled.
- Preserves Haiku 4.5 `thinking: { "type": "enabled" }`; Haiku supports manual extended thinking, not adaptive thinking.

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

Haiku can fail while Opus/Sonnet work because some Sub2API Claude OAuth mimic paths historically treated Haiku differently from Sonnet/Opus. The relevant upstream fix is to apply the full Claude Code mimicry beta/header behavior to Haiku too. Haiku 4.5 supports manual extended thinking (`type: "enabled"` with a token budget), but not adaptive thinking.

## Credits

Inspired by:

- [`ianjwhite99/opencode-with-claude`](https://github.com/ianjwhite99/opencode-with-claude), an OpenCode plugin for using Claude subscriptions through a local proxy.
- [`Wei-Shaw/sub2api` PR #2756](https://github.com/Wei-Shaw/sub2api/pull/2756) by `Wuxie233`, which documents and fixes the Haiku OAuth mimicry header/beta parity issue.

## License

MIT
