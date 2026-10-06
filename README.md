# opencode-anthropic

OpenCode V2 plugin that brings **Claude Pro/Max OAuth** back to the Anthropic
provider.

OpenCode V2 removed Anthropic OAuth after a legal request from Anthropic, but
the plumbing is still there: OAuth credentials are stored and sent as
`Authorization: Bearer`. This plugin completes the picture:

- keeps Claude tokens fresh (refresh 10 minutes before expiry, single-flight,
  with backoff and a cross-process fallback);
- sends the current Claude Code signature: identity system block, `user-agent`,
  `x-app`, `x-claude-code-session-id`, and the 2.1.289 beta flags;
- exposes OpenCode tools under Claude Code names (`shell` → `Bash`, `subagent`
  → `Agent`, ...) and translates Claude Code argument shapes (`file_path`,
  `old_string`, `run_in_background`) back onto OpenCode schemas before they are
  parsed;
- honours Anthropic's `retry-after` hint when OpenCode retries a rate limit.

It is a V2 port of the community
[`opencode-anthropic-oauth`](https://www.npmjs.com/package/opencode-anthropic-oauth)
(MIT) plugin, which only runs on OpenCode V1.

> **Warning:** Anthropic's Terms of Service (Feb 2026) say OAuth tokens from
> Free/Pro/Max plans must only be used by official clients. This plugin is a
> community workaround: it can stop working without notice and you use it at
> your own risk (there are reports of banned accounts).

## Requirements

- OpenCode V2 (tested with 2.0.22);
- Node.js 20+ (for the login script and tests);
- A Claude Pro/Max subscription.

## Install

Point the OpenCode config at a checkout of this repository (global config
example, `~/.config/opencode/opencode.json`):

```jsonc
{
  "plugins": [
    "../path/to/opencode-anthropic"
  ]
}
```

Or copy the directory into `~/.config/opencode/plugins/opencode-anthropic/`,
where local plugins are auto-discovered. Restart the OpenCode service after
changing plugins: `opencode service restart`.

## Login

```bash
node login.mjs            # from a checkout
# or, when installed from npm:
opencode-anthropic login
```

Add `--no-browser` to only print the authorization URL. The script opens the
browser flow, asks for the code Anthropic shows, exchanges it for tokens,
registers the credential in the running OpenCode server over its local HTTP
API (tokens never travel through process arguments), and saves a local cache
in `~/.local/share/opencode/opencode-anthropic.json` (mode `0600`).

Then pick an `anthropic/claude-*` model in OpenCode. The plugin refreshes the
token automatically.

## How it works

- **Strict gating.** The plugin only acts while an Anthropic **OAuth**
  credential is the active connection. API keys, env credentials, and the
  logged-out state pass through untouched — no surprises with `ps`, no stale
  tokens resurrected after logout.
- **Connection-bound cache.** Refreshed tokens are stored in plugin storage
  and in the token file, tagged with the OpenCode connection id they belong
  to. Cached tokens from another connection (account switch, re-login) are
  ignored.
- **Refresh.** Tokens within 10 minutes of expiry are refreshed before the
  request. Concurrent requests share one refresh; a failed refresh backs off
  for 5 minutes. If another process refreshed first, a still-valid cached
  token is used instead of failing the request.
- **Request shaping.** `http.request` hook (provider `anthropic`): replaces
  the authorization header with a fresh bearer token, removes `x-api-key`,
  sets `user-agent: claude-cli/<version> (external, cli)`, `x-app: cli`,
  `x-claude-code-session-id` (a stable UUID per OpenCode session),
  `anthropic-dangerous-direct-browser-access: true`, and merges the
  `anthropic-beta` flags.
- **Response shaping.** `http.response` hook: parses SSE events, renames
  `tool_use.name` back to the OpenCode name, and translates the arguments of
  mapped tools. Argument fragments are held until the content block closes;
  when nothing changes the original frames are passed through byte for byte,
  and unparseable fragments fall back untouched.
- **Rate limits.** A 429/503/529 response records Anthropic's `retry-after`
  value; the session `retry` hook hands it back as the retry delay instead of
  letting OpenCode hammer the endpoint.

### System prompt and tools

The default `prepend` mode adds the current Claude Code identity ("You are a
Claude agent, built on Anthropic's Claude Agent SDK.") as the first `system`
block and keeps the OpenCode prompt right after it. Set
`ANTHROPIC_OAUTH_SYSTEM_IDENTITY` (or the `identity` option) to pin the 2025
wording or your own string.

`tools.mjs` holds an explicit compatibility table: only OpenCode tools with a
Claude Code counterpart are renamed, and each mapped tool also translates the
argument shapes a Claude Code model may produce:

| OpenCode | Exposed as | Arguments translated |
| --- | --- | --- |
| `read` | `Read` | `file_path` → `path`; drops `pages` |
| `write` | `Write` | `file_path` → `path` |
| `edit` | `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` |
| `shell` | `Bash` | `run_in_background` → `background`; drops `description` |
| `grep` | `Grep` | `glob` → `include`, `head_limit` → `limit`, `-i` |
| `subagent` | `Agent` | `subagent_type` → `agent`, `run_in_background` → `background` |
| `question` | `AskUserQuestion` | `multiSelect` → `multiple` |
| `todowrite` | `TodoWrite` | drops `activeForm` |
| `webfetch` | `WebFetch` | drops `prompt` |
| `websearch` | `WebSearch` | drops domain filters |
| `skill` | `Skill` | `skill` → `id`; drops `args` |
| `glob` | `Glob` | — |

OpenCode-only tools (`compress`, `todoread`, `execute`/Code Mode) and unknown
tools (MCP) are left untouched. `toolAliases` can override any mapping, e.g.
`{ "subagent": "Task" }` for the pre-2.1 Claude Code name.

## Configuration

Options can be passed through the OpenCode config:

```jsonc
{
  "plugins": [
    {
      "package": "../path/to/opencode-anthropic",
      "options": {
        "systemMode": "prepend",
        "renameTools": true,
        "toolAliases": { "my_tool": "Read" }
      }
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `systemMode` | `prepend` | `prepend`, `replace` (rewrites the first block), or `off` |
| `identity` | current Claude Code line | Overrides the injected identity string |
| `renameTools` | `true` | Rename tools to Claude Code casing and back |
| `toolAliases` | `{}` | Extra or overriding tool-name mappings |

Environment variables (useful when the plugin is loaded as a directory):
`ANTHROPIC_OAUTH_SYSTEM_MODE`, `ANTHROPIC_OAUTH_SYSTEM_IDENTITY`,
`ANTHROPIC_OAUTH_RENAME_TOOLS=0`, `ANTHROPIC_OAUTH_TOOL_ALIASES` (JSON),
`ANTHROPIC_OAUTH_DUMP` (append every transformed OAuth request to a JSONL
file), `ANTHROPIC_CLI_VERSION`, `ANTHROPIC_BETA_FLAGS`, `XDG_DATA_HOME`.

## Troubleshooting

- **401/403 on every request** — the refresh token was revoked or the login
  expired. Run the login again.
- **Provider does not show up** — check `opencode auth list`; the
  "Claude Pro/Max" credential must exist.
- **Tools do not execute** — try `ANTHROPIC_OAUTH_RENAME_TOOLS=0` and restart
  the service.
- **Logout** — remove the credential with `/connect`; cached tokens are
  ignored automatically because no OAuth connection is active anymore.

## Development

No dependencies; tests use the Node.js built-in runner and a mock token
server:

```bash
node --test
```

The repo includes a headless capture tool that runs the local `claude` binary
against a mock endpoint with an isolated config dir (no account, no real API):

```bash
npm run capture                                  # capture + summarise
node scripts/claude-capture.mjs --compare a.json b.json
```

`--compare` accepts a Claude capture and an OpenCode side (for example the
JSONL written by `ANTHROPIC_OAUTH_DUMP`).

## Known limitations

- OpenCode's native `/connect` flow has no Anthropic OAuth method and the
  claude.ai client id/endpoints are no longer present in the OpenCode binary,
  so the bundled `login.mjs` script is the supported login path.
- The plugin targets a Claude Code compatibility profile
  (`claude-cli/2.1.289`). Newer releases can be selected with
  `ANTHROPIC_CLI_VERSION`, but the beta flags and tool list may need updating.
- Claude Code enables extended thinking by default
  (`thinking: { type: "enabled", budget_tokens: max_tokens - 1 }`); this
  plugin does not force it and keeps whatever OpenCode decides. The
  interleaved-thinking and thinking-token-count betas are always sent.
- The plugin deliberately does not fabricate account metadata
  (`x-anthropic-billing-header`, `metadata.user_id` device ids): it aligns
  client behaviour, not identity.
- Refreshed tokens are kept in plugin storage and in the token file; OpenCode's
  stored credential keeps the original access token until the next login.

## Credits and license

MIT. Ported from
[`opencode-anthropic-oauth`](https://github.com/shahidshabbir-se/opencode-anthropic-oauth)
(MIT) by shahidshabbir-se. See [LICENSE](LICENSE).
