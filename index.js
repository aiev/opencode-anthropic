// OpenCode V2 plugin: Claude Pro/Max OAuth support for the Anthropic provider.
//
// OpenCode V2 removed Anthropic OAuth, but it still stores OAuth credentials
// and sends them as `Authorization: Bearer`. This plugin completes the
// picture: it keeps tokens fresh, injects the Claude Code identity and beta
// headers, and renames tools so Anthropic routes requests like official
// Claude Code.
//
// Token safety rules:
// - The plugin only acts while an Anthropic OAuth credential is the active
//   connection. API keys and logged-out states pass through untouched.
// - Cached tokens are bound to the connection id they were issued for, so a
//   logout or an account switch can never revive an old session from disk.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BETA_FLAGS, TOKENS_FILE, USER_AGENT, refreshTokens } from "./oauth.mjs";
import { buildToolNameMaps, parseAliases, transformRequestBody, transformResponseStream } from "./transform.mjs";

const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const REFRESH_RETRY_MS = 5 * 60 * 1000;
const TOKEN_CACHE_MS = 30 * 1000;
export const LOGIN_HINT =
  "opencode-anthropic: Claude Pro/Max login is missing or expired. Run `opencode-anthropic login` (or `node <plugin-dir>/login.mjs`) to sign in again.";

function isUsableTokens(value) {
  return Boolean(
    value && typeof value.access === "string" && value.access && typeof value.refresh === "string" && value.refresh,
  );
}

function readFileTokens() {
  try {
    const data = JSON.parse(readFileSync(TOKENS_FILE, "utf8"));
    if (isUsableTokens(data)) return data;
  } catch {}
  return null;
}

function writeFileTokens(tokens) {
  try {
    mkdirSync(dirname(TOKENS_FILE), { recursive: true });
    const temp = `${TOKENS_FILE}.tmp`;
    writeFileSync(temp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    renameSync(temp, TOKENS_FILE);
    chmodSync(TOKENS_FILE, 0o600);
  } catch (error) {
    console.error("opencode-anthropic: failed to persist tokens to disk:", error);
  }
}

export default {
  id: "opencode-anthropic",
  async setup(ctx) {
    const options = {
      systemMode: ctx.options?.systemMode ?? process.env.ANTHROPIC_OAUTH_SYSTEM_MODE ?? "prepend",
      renameTools: ctx.options?.renameTools ?? process.env.ANTHROPIC_OAUTH_RENAME_TOOLS !== "0",
      toolAliases: {
        ...parseAliases(process.env.ANTHROPIC_OAUTH_TOOL_ALIASES),
        ...(ctx.options?.toolAliases ?? {}),
      },
    };
    const { forward, reverse } = buildToolNameMaps(options.toolAliases);
    const requestOptions = { systemMode: options.systemMode, renameTools: options.renameTools, forward };

    let cached = null;
    let cachedAt = 0;
    let refreshPromise = null;
    let refreshFailedAt = 0;

    async function activeOAuthConnection() {
      try {
        const connection = await ctx.integration.connection.active("anthropic");
        if (!connection || connection.type !== "credential") return null;
        const value = await ctx.integration.connection.resolve(connection);
        if (value?.type !== "oauth" || !isUsableTokens(value)) return null;
        return { id: connection.id, tokens: value };
      } catch (error) {
        console.error("opencode-anthropic: failed to resolve the Anthropic connection:", error);
        return null;
      }
    }

    function boundTo(value, connectionID) {
      return isUsableTokens(value) && value.connectionID === connectionID ? value : null;
    }

    async function storedTokens() {
      try {
        return await ctx.storage.get("tokens");
      } catch (error) {
        console.error("opencode-anthropic: failed to read plugin storage:", error);
        return null;
      }
    }

    async function loadTokens(force = false) {
      if (!force && cached && Date.now() - cachedAt < TOKEN_CACHE_MS) return cached;
      cached = null;
      cachedAt = Date.now();
      const connection = await activeOAuthConnection();
      if (!connection) return null;
      const candidates = [
        { ...connection.tokens, connectionID: connection.id },
        boundTo(await storedTokens(), connection.id),
        boundTo(readFileTokens(), connection.id),
      ].filter(Boolean);
      // The newest expiry wins: refreshed copies outrank the stale access
      // token that OpenCode keeps in the credential record.
      candidates.sort((a, b) => (b.expires ?? 0) - (a.expires ?? 0));
      cached = candidates[0] ?? null;
      return cached;
    }

    async function persist(tokens) {
      try {
        await ctx.storage.set("tokens", tokens);
      } catch (error) {
        console.error("opencode-anthropic: failed to persist tokens in plugin storage:", error);
      }
      writeFileTokens(tokens);
    }

    async function freshAccess() {
      const tokens = await loadTokens();
      if (!tokens) return null;
      if ((tokens.expires ?? 0) > Date.now() + REFRESH_BUFFER_MS) return tokens.access;
      if (refreshFailedAt && Date.now() - refreshFailedAt < REFRESH_RETRY_MS) return tokens.access;
      if (!refreshPromise) {
        refreshPromise = (async () => {
          try {
            const latest = (await loadTokens(true)) ?? tokens;
            if ((latest.expires ?? 0) > Date.now() + REFRESH_BUFFER_MS) return latest.access;
            const refreshed = await refreshTokens(latest.refresh);
            const next = { ...latest, ...refreshed, connectionID: latest.connectionID };
            cached = next;
            cachedAt = Date.now();
            refreshFailedAt = 0;
            await persist(next);
            return next.access;
          } catch (error) {
            refreshFailedAt = Date.now();
            // Another process may have refreshed first: re-read and use a
            // still-valid token instead of failing the request.
            const fallback = (await loadTokens(true)) ?? tokens;
            if ((fallback.expires ?? 0) > Date.now()) return fallback.access;
            throw error;
          }
        })().finally(() => {
          refreshPromise = null;
        });
      }
      return refreshPromise;
    }

    await ctx.session.hook(
      "http.request",
      async (event) => {
        try {
          const tokens = await loadTokens();
          if (!tokens) return; // API key or logged out: leave the request alone.
          const access = (await freshAccess()) ?? tokens.access;
          const headers = event.request.headers;
          headers.set("authorization", `Bearer ${access}`);
          headers.delete("x-api-key");
          headers.set("x-app", "cli");
          headers.set("anthropic-dangerous-direct-browser-access", "true");
          headers.set("user-agent", USER_AGENT);
          const incoming = (headers.get("anthropic-beta") || "")
            .split(",")
            .map((flag) => flag.trim())
            .filter(Boolean);
          const required = BETA_FLAGS.split(",").map((flag) => flag.trim());
          headers.set("anthropic-beta", [...new Set([...required, ...incoming])].join(","));

          if ((options.systemMode !== "off" || options.renameTools) && event.request.body) {
            const raw = await event.request.clone().text();
            const transformed = transformRequestBody(raw, requestOptions);
            if (transformed !== raw) {
              event.request = new Request(event.request.url, {
                method: event.request.method,
                headers,
                body: transformed,
                signal: event.request.signal,
              });
            }
          }
        } catch (error) {
          const message = String(error?.message ?? error);
          if (message.includes("Token refresh failed")) console.error(`${LOGIN_HINT} (${message})`);
          else console.error("opencode-anthropic: request hook failed:", error);
        }
      },
      { providerID: "anthropic" },
    );

    await ctx.session.hook(
      "http.response",
      (event) => {
        try {
          if (!options.renameTools || !event.response.ok || !event.response.body) return;
          event.response = transformResponseStream(event.response, reverse);
        } catch (error) {
          console.error("opencode-anthropic: response hook failed:", error);
        }
      },
      { providerID: "anthropic" },
    );
  },
};
