# opencode-anthropic

OpenCode V2 plugin that brings **Claude Pro/Max OAuth** back to the Anthropic
provider.

OpenCode V2 removed Anthropic OAuth after a legal request from Anthropic, but
the plumbing is still there: OAuth credentials are stored and sent as
`Authorization: Bearer`. This plugin completes the picture:

- keeps Claude tokens fresh (refresh 10 minutes before expiry, single-flight,
  with backoff and a cross-process fallback);
- injects the Claude Code identity, `user-agent`, `x-app`, and beta headers;
- renames OpenCode tools to Claude Code casing on the way out and back on the
  way in, parsing the SSE stream instead of regexing raw bytes.

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
  `anthropic-dangerous-direct-browser-access: true`, and merges the
  `anthropic-beta` flags.
- **Response shaping.** `http.response` hook: parses SSE events and renames
  only `tool_use.name` back to the OpenCode name. Tool arguments
  (`partial_json`), text, and every other byte are preserved.

### System prompt and tools

The default `prepend` mode adds the Claude Code identity as the first `system`
block and keeps the OpenCode prompt right after it. Tools are renamed with the
Claude Code casing (`read` → `Read`, `question` → `AskUserQuestion`, and the
rest of the canonical list). Unknown tools (for example MCP tools) are left
alone.

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
| `renameTools` | `true` | Rename tools to Claude Code casing and back |
| `toolAliases` | `{ question: "AskUserQuestion" }` | Extra or overriding tool-name mappings |

Environment variables (useful when the plugin is loaded as a directory):
`ANTHROPIC_OAUTH_SYSTEM_MODE`, `ANTHROPIC_OAUTH_RENAME_TOOLS=0`,
`ANTHROPIC_OAUTH_TOOL_ALIASES` (JSON), `ANTHROPIC_CLI_VERSION`,
`ANTHROPIC_BETA_FLAGS`, `XDG_DATA_HOME`.

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

## Known limitations

- OpenCode's native `/connect` flow has no Anthropic OAuth method and the
  claude.ai client id/endpoints are no longer present in the OpenCode binary,
  so the bundled `login.mjs` script is the supported login path.
- The plugin targets a Claude Code compatibility profile
  (`claude-cli/2.1.289`). Newer releases can be selected with
  `ANTHROPIC_CLI_VERSION`, but the beta flags and tool list may need updating.
- Refreshed tokens are kept in plugin storage and in the token file; OpenCode's
  stored credential keeps the original access token until the next login.

## Credits and license

MIT. Ported from
[`opencode-anthropic-oauth`](https://github.com/shahidshabbir-se/opencode-anthropic-oauth)
(MIT) by shahidshabbir-se. See [LICENSE](LICENSE).
