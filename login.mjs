#!/usr/bin/env node
// Interactive login for Claude Pro/Max OAuth.
//
// Usage:
//   opencode-anthropic login                  (installed package)
//   node /path/to/login.mjs                   (source checkout)
//   node /path/to/login.mjs --no-browser      (print the URL only)
//
// The script opens the browser flow, exchanges the pasted code for tokens,
// registers an Anthropic OAuth credential in the running OpenCode server, and
// saves a local token cache bound to that credential. Token values never
// travel through process arguments: the server is reached directly over its
// local HTTP API.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface as createPrompt } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { TOKENS_FILE, createAuthorizationRequest, exchangeCodeForTokens } from "./oauth.mjs";

const METHOD_ID = "claude-pro-max";
const LABEL = "Claude Pro/Max";
const noBrowser = process.argv.slice(2).includes("--no-browser");

function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function discoverServer() {
  const override = process.env.OPENCODE_SERVER_URL;
  if (override) return override.replace(/\/+$/, "");
  const result = spawnSync("opencode", ["service", "status"], { encoding: "utf8" });
  const match = /(https?:\/\/[^\s]+)/.exec(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  return match ? match[1].replace(/\/+$/, "") : null;
}

async function api(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: response.ok, status: response.status, data };
}

function printRegistrationFailure(reason) {
  console.log("");
  console.log(`! Could not register the credential in OpenCode: ${reason}.`);
  console.log("  Make sure OpenCode is running and the `opencode` CLI is on your PATH,");
  console.log("  then run the login again. Without the credential the plugin stays inactive.");
}

async function registerCredential(tokens) {
  const base = discoverServer();
  if (!base) {
    printRegistrationFailure("could not find the OpenCode server (is the `opencode` CLI on your PATH?)");
    return null;
  }
  const list = await api(base, "GET", "/api/credential");
  if (!list.ok || !Array.isArray(list.data?.data)) {
    printRegistrationFailure(`the server answered HTTP ${list.status} while listing credentials`);
    return null;
  }
  for (const entry of list.data.data) {
    if (entry.integrationID === "anthropic" && entry.value?.type === "oauth" && entry.value?.methodID === METHOD_ID) {
      await api(base, "DELETE", `/api/credential/${entry.id}`);
    }
  }
  const created = await api(base, "POST", "/api/credential", {
    integrationID: "anthropic",
    label: LABEL,
    value: {
      type: "oauth",
      methodID: METHOD_ID,
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
    },
    activate: true,
  });
  if (!created.ok) {
    printRegistrationFailure(`the server answered HTTP ${created.status} while creating the credential`);
    return null;
  }
  return created.data?.data?.id ?? null;
}

function saveTokens(tokens) {
  mkdirSync(dirname(TOKENS_FILE), { recursive: true });
  const temp = `${TOKENS_FILE}.tmp`;
  writeFileSync(temp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  renameSync(temp, TOKENS_FILE);
  chmodSync(TOKENS_FILE, 0o600);
}

const { url, verifier } = createAuthorizationRequest();
console.log("");
console.log("Open the URL below in your browser and authorize with your Claude Pro/Max account:");
console.log("");
console.log(`  ${url}`);
console.log("");
if (!noBrowser && openBrowser(url)) {
  console.log("(tried to open your browser — use the URL above if it did not)");
  console.log("");
}
const prompt = createPrompt({ input: stdin, output: stdout });
const code = (await prompt.question("Paste the code shown by Anthropic here: ")).trim();
prompt.close();
if (!code) {
  console.error("\nNo code provided. Nothing was saved.");
  process.exit(1);
}

console.log("\nExchanging the code for tokens...");
let tokens;
try {
  tokens = await exchangeCodeForTokens(code, verifier);
} catch (error) {
  const detail = String(error?.message ?? error);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network/i.test(detail)) {
    console.error("\nNetwork failure while talking to Anthropic. Check your connection and try again.");
  } else if (/Token exchange failed: 4\d\d/.test(detail)) {
    console.error("\nAnthropic rejected the code (invalid or expired). Run the login again and paste a fresh code.");
  } else {
    console.error(`\nLogin failed: ${detail}`);
  }
  process.exit(1);
}

const connectionID = await registerCredential(tokens);
saveTokens({ ...tokens, ...(connectionID ? { connectionID } : {}) });
if (!connectionID) process.exit(1);

console.log("");
console.log("Login complete. Tokens saved to:");
console.log(`  ${TOKENS_FILE}`);
console.log(`Access token expires at ${new Date(tokens.expires).toLocaleString()} (refreshed automatically).`);
console.log("");
console.log("Open a new OpenCode session and select an anthropic/claude-* model.");
console.log("Tip: if you just updated the plugin, restart the service first: opencode service restart");
