// OAuth PKCE helpers for the Anthropic Claude Pro/Max flow.
// Ported from opencode-anthropic-oauth (MIT) so the params stay identical.
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLIENT_ID = process.env.ANTHROPIC_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTHORIZE_URL = process.env.ANTHROPIC_AUTHORIZE_URL || "https://claude.ai/oauth/authorize";
export const TOKEN_URL = process.env.ANTHROPIC_TOKEN_URL || "https://platform.claude.com/v1/oauth/token";
export const REDIRECT_URI = process.env.ANTHROPIC_REDIRECT_URI || "https://platform.claude.com/oauth/code/callback";
const SCOPES =
  process.env.ANTHROPIC_SCOPES ||
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
// The Claude Code profile this plugin targets. Override with
// ANTHROPIC_CLI_VERSION when a newer release needs different headers.
const CLI_VERSION = process.env.ANTHROPIC_CLI_VERSION || "2.1.289";
export const USER_AGENT = process.env.ANTHROPIC_USER_AGENT || `claude-cli/${CLI_VERSION} (external, cli)`;
export const BETA_FLAGS =
  process.env.ANTHROPIC_BETA_FLAGS ||
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05";

const DATA_DIR = process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "opencode") : join(homedir(), ".local", "share", "opencode");
export const TOKENS_FILE = join(DATA_DIR, "opencode-anthropic.json");

function base64url(buffer) {
  return buffer.toString("base64url").replace(/=+$/, "");
}

async function fetchWithRetry(url, init, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const response = await fetch(url, init);
    if (response.status === 429 && attempt < retries - 1) {
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 2000));
      continue;
    }
    return response;
  }
  return fetch(url, init);
}

export function createAuthorizationRequest() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const params = new URLSearchParams({
    code: "true",
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });
  return { url: `${AUTHORIZE_URL}?${params}`, verifier };
}

export function parseAuthCode(raw) {
  const hashIndex = raw.indexOf("#");
  return hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
}

export async function exchangeCodeForTokens(rawCode, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: parseAuthCode(rawCode.trim()),
    code_verifier: verifier,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: verifier,
  });
  const response = await fetchWithRetry(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: body.toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Token exchange failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`);
  }
  const data = await response.json();
  if (!data.access_token || !data.refresh_token) throw new Error("Token exchange returned no tokens");
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + (data.expires_in ?? 36000) * 1000,
  };
}

export async function refreshTokens(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
  const response = await fetchWithRetry(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: body.toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Token refresh failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`);
  }
  const data = await response.json();
  if (!data.access_token) throw new Error("Token refresh returned no access token");
  return {
    access: data.access_token,
    refresh: data.refresh_token || refreshToken,
    expires: Date.now() + (data.expires_in ?? 36000) * 1000,
  };
}
