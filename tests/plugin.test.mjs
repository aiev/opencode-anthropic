// End-to-end tests for the opencode-anthropic plugin. They run the real plugin
// code against a fake OpenCode context and a mock token server; no network
// access or real credentials are involved.
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const workdir = mkdtempSync(join(tmpdir(), "opencode-anthropic-test-"));
process.env.XDG_DATA_HOME = join(workdir, "xdg");

let tokenMode = "rotate";
let tokenRequests = [];
const tokenServer = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    tokenRequests.push(body);
    if (tokenMode === "fail") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        access_token: `access-${tokenRequests.length}`,
        refresh_token: `refresh-${tokenRequests.length}`,
        expires_in: 3600,
      }),
    );
  });
});
await new Promise((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${tokenServer.address().port}/token`;

const { default: plugin, LOGIN_HINT } = await import("../index.js");
const { SYSTEM_IDENTITY, buildToolNameMaps, rewriteEvent, transformResponseStream } = await import("../transform.mjs");

after(() => {
  tokenServer.close();
  rmSync(workdir, { recursive: true, force: true });
});

function makeContext({ connection = null, credential = null, options = {}, stored = null } = {}) {
  const storage = new Map();
  if (stored) storage.set("tokens", stored);
  const hooks = new Map();
  const state = { connection, credential };
  const ctx = {
    options,
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => void storage.set(key, value),
    },
    integration: {
      connection: {
        active: async () => state.connection,
        resolve: async () => state.credential,
      },
    },
    session: {
      hook: async (name, callback) => {
        if (!hooks.has(name)) hooks.set(name, []);
        hooks.get(name).push(callback);
        return { dispose: async () => {} };
      },
    },
  };
  return {
    ctx,
    state,
    storage,
    async request(body) {
      const event = {
        request: new Request("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "must-be-removed" },
          body: JSON.stringify(body),
        }),
      };
      for (const hook of hooks.get("http.request") ?? []) await hook(event);
      return event.request;
    },
  };
}

const oauthConnection = (id) => ({ type: "credential", id, label: "Claude Pro/Max", method: "oauth" });
const keyConnection = { type: "credential", id: "cred_key", label: "API key", method: "key" };
const expiredOAuth = {
  type: "oauth",
  methodID: "claude-pro-max",
  access: "stale-access",
  refresh: "old-refresh",
  expires: Date.now() - 1000,
};

function sampleBody() {
  return {
    model: "claude-sonnet-4-5",
    system: [{ type: "text", text: "You are an AI agent running in OpenCode", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "read" }, { name: "todowrite" }, { name: "compress" }, { name: "question" }],
    messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "write", input: {} }] }],
    stream: true,
  };
}

async function captureConsoleErrors(run) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await run();
  } finally {
    console.error = original;
  }
  return errors;
}

test("refreshes expired OAuth tokens, transforms the request, and caches the result", async () => {
  tokenMode = "rotate";
  tokenRequests = [];
  const fake = makeContext({ connection: oauthConnection("cred_refresh"), credential: expiredOAuth });
  await plugin.setup(fake.ctx);

  const request = await fake.request(sampleBody());
  assert.equal(request.headers.get("authorization"), "Bearer access-1", "fresh bearer injected");
  assert.equal(request.headers.get("x-api-key"), null, "x-api-key removed");
  assert.equal(request.headers.get("x-app"), "cli");
  assert.match(request.headers.get("user-agent"), /^claude-cli\//);
  assert.match(request.headers.get("anthropic-beta"), /oauth-2025-04-20/);
  assert.match(request.headers.get("anthropic-beta"), /claude-code-20250219/);

  const parsed = JSON.parse(await request.text());
  assert.equal(parsed.system[0].text, SYSTEM_IDENTITY, "identity prepended");
  assert.equal(parsed.system[1].text, "You are an AI agent running in OpenCode", "original prompt kept");
  assert.deepEqual(
    parsed.tools.map((tool) => tool.name),
    ["Read", "TodoWrite", "compress", "AskUserQuestion"],
    "tools renamed to Claude Code casing",
  );
  assert.equal(parsed.messages[0].content[0].name, "Write", "history tool_use renamed");

  assert.equal(tokenRequests.length, 1, "one refresh call made");
  assert.match(tokenRequests[0], /grant_type=refresh_token/);
  assert.match(tokenRequests[0], /refresh_token=old-refresh/);
  const stored = fake.storage.get("tokens");
  assert.equal(stored.access, "access-1", "refreshed access persisted");
  assert.equal(stored.refresh, "refresh-1", "rotated refresh persisted");
  assert.equal(stored.connectionID, "cred_refresh", "cached tokens are bound to the connection");

  const second = await fake.request(sampleBody());
  assert.equal(tokenRequests.length, 1, "no refresh while the token is valid");
  assert.equal(second.headers.get("authorization"), "Bearer access-1");
});

test("leaves API-key connections untouched", async () => {
  tokenMode = "rotate";
  const fake = makeContext({ connection: keyConnection, credential: { type: "key", key: "sk-ant-test" } });
  await plugin.setup(fake.ctx);
  const request = await fake.request(sampleBody());
  assert.equal(request.headers.get("x-api-key"), "must-be-removed", "x-api-key untouched");
  assert.equal(request.headers.get("authorization"), null, "no bearer injected");
  const parsed = JSON.parse(await request.text());
  assert.equal(parsed.system[0].text, "You are an AI agent running in OpenCode", "system untouched");
  assert.deepEqual(
    parsed.tools.map((tool) => tool.name),
    ["read", "todowrite", "compress", "question"],
    "tools untouched",
  );
});

test("stays inactive when there is no active credential (e.g. after logout)", async () => {
  const fake = makeContext({
    connection: null,
    credential: null,
    stored: { access: "cached", refresh: "cached-refresh", expires: Date.now() + 3600_000, connectionID: "cred_2" },
  });
  await plugin.setup(fake.ctx);
  const request = await fake.request(sampleBody());
  assert.equal(request.headers.get("authorization"), null, "no bearer injected");
  assert.equal(request.headers.get("x-api-key"), "must-be-removed", "request left alone");
});

test("ignores cached tokens issued for a different connection", async () => {
  tokenMode = "rotate";
  tokenRequests = [];
  const fake = makeContext({
    connection: oauthConnection("cred_mismatch"),
    credential: expiredOAuth,
    stored: {
      access: "other-access",
      refresh: "other-refresh",
      expires: Date.now() + 3600_000,
      connectionID: "cred_other",
    },
  });
  await plugin.setup(fake.ctx);
  const request = await fake.request(sampleBody());
  assert.equal(request.headers.get("authorization"), "Bearer access-1", "refreshed from the active credential");
  assert.equal(tokenRequests.length, 1, "refresh was attempted");
});

test("falls back to a still-valid cached token when refresh fails", async () => {
  tokenMode = "fail";
  tokenRequests = [];
  const errors = await captureConsoleErrors(async () => {
    const fake = makeContext({
      connection: oauthConnection("cred_fallback"),
      credential: expiredOAuth,
      stored: {
        access: "cached-valid",
        refresh: "old-refresh",
        expires: Date.now() + 5 * 60 * 1000,
        connectionID: "cred_fallback",
      },
    });
    await plugin.setup(fake.ctx);
    const request = await fake.request(sampleBody());
    assert.equal(request.headers.get("authorization"), "Bearer cached-valid");
    assert.equal(tokenRequests.length, 1, "refresh was attempted");
  });
  tokenMode = "rotate";
  assert.equal(errors.length, 0, "no error logged when a fallback exists");
});

test("reports a login hint when refresh fails with no usable token", async () => {
  tokenMode = "fail";
  tokenRequests = [];
  const errors = await captureConsoleErrors(async () => {
    const fake = makeContext({ connection: oauthConnection("cred_hint"), credential: expiredOAuth });
    await plugin.setup(fake.ctx);
    const request = await fake.request(sampleBody());
    assert.equal(request.headers.get("authorization"), null, "request left for the next login");
    assert.equal(request.headers.get("x-api-key"), "must-be-removed");
  });
  tokenMode = "rotate";
  assert.ok(
    errors.some((message) => message.includes(LOGIN_HINT)),
    "login hint logged",
  );
});

test("rewrites streamed tool names without touching tool arguments", async () => {
  const { reverse } = buildToolNameMaps();
  const frames = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\": \\"Read\\"}"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
  const encoder = new TextEncoder();
  const chunks = [];
  for (let index = 0; index < frames.length; index += 7) chunks.push(frames.slice(index, index + 7));
  const source = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const transformed = transformResponseStream(new Response(source, { status: 200 }), reverse);
  const text = await transformed.text();
  const lines = text.split("\n");
  const startLine = lines.find((line) => line.startsWith("data:") && line.includes("content_block_start"));
  assert.equal(JSON.parse(startLine.slice(5)).content_block.name, "read", "tool name reversed");
  const deltaLine = lines.find((line) => line.includes("input_json_delta"));
  assert.equal(
    JSON.parse(deltaLine.slice(5)).delta.partial_json,
    '{"path": "Read"}',
    "partial_json byte-for-byte preserved",
  );

  const aliasEvent = rewriteEvent(
    'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"AskUserQuestion"}}\n\n',
    reverse,
  );
  assert.match(aliasEvent, /"name":"question"/, "aliased tool maps back to its OpenCode name");
});

test("supports replace and off system modes", async () => {
  tokenMode = "rotate";
  const fresh = { ...expiredOAuth, access: "fresh", expires: Date.now() + 3600_000 };

  const replaceFake = makeContext({
    connection: oauthConnection("cred_modes"),
    credential: fresh,
    options: { systemMode: "replace" },
  });
  await plugin.setup(replaceFake.ctx);
  const replaced = JSON.parse(await (await replaceFake.request(sampleBody())).text());
  assert.equal(replaced.system[0].text, SYSTEM_IDENTITY);
  assert.equal(replaced.system[0].cache_control.type, "ephemeral", "first block metadata kept");
  assert.equal(replaced.system.length, 1, "single system block");

  const offFake = makeContext({
    connection: oauthConnection("cred_modes"),
    credential: fresh,
    options: { systemMode: "off" },
  });
  await plugin.setup(offFake.ctx);
  const off = JSON.parse(await (await offFake.request(sampleBody())).text());
  assert.equal(off.system[0].text, "You are an AI agent running in OpenCode");
  assert.equal(off.system.length, 1, "system untouched");
});
