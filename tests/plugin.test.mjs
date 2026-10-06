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
const { SYSTEM_IDENTITY, buildToolNameMaps, rewriteEvent, transformResponseStream, sessionUUID, translateToolInput } =
  await import("../transform.mjs");
const { parseRetryAfter } = await import("../retry.mjs");

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
    tool: {
      hook: async (name, callback) => {
        const key = `tool:${name}`;
        if (!hooks.has(key)) hooks.set(key, []);
        hooks.get(key).push(callback);
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
        sessionID: "ses_test",
        kind: "primary",
        request: new Request("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "must-be-removed" },
          body: JSON.stringify(body),
        }),
      };
      for (const hook of hooks.get("http.request") ?? []) await hook(event);
      return event.request;
    },
    async respond(response) {
      const event = { response };
      for (const hook of hooks.get("http.response") ?? []) await hook(event);
      return event.response;
    },
    async retry(error, attempt = 2, decision = { retry: false }) {
      const event = { error, attempt, decision };
      for (const hook of hooks.get("retry") ?? []) await hook(event);
      return event.decision;
    },
    async toolBefore(tool, input) {
      const event = { tool, input };
      for (const hook of hooks.get("tool:execute.before") ?? []) await hook(event);
      return event.input;
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
    tools: [
      { name: "read" },
      { name: "todowrite" },
      { name: "compress" },
      { name: "question" },
      { name: "shell" },
      { name: "subagent" },
    ],
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
    ["Read", "TodoWrite", "compress", "AskUserQuestion", "Bash", "Agent"],
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
    ["read", "todowrite", "compress", "question", "shell", "subagent"],
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
  const transformed = transformResponseStream(new Response(source, { status: 200 }), { reverse });
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

test("translates streamed Claude Code tool arguments before OpenCode parses them", async () => {
  const { reverse } = buildToolNameMaps();
  const frames = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_2","name":"Read","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"path\\": \\"/tmp/a.txt\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  ].join("");
  const encoder = new TextEncoder();
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  });
  const transformed = await transformResponseStream(new Response(source, { status: 200 }), { reverse }).text();
  const startLine = transformed.split("\n").find((line) => line.startsWith("data:") && line.includes("content_block_start"));
  assert.equal(JSON.parse(startLine.slice(5)).content_block.name, "read", "tool name reversed");
  const deltaLine = transformed.split("\n").find((line) => line.startsWith("data:") && line.includes("input_json_delta"));
  assert.equal(
    JSON.parse(deltaLine.slice(5)).delta.partial_json,
    '{"path":"/tmp/a.txt"}',
    "arguments translated to OpenCode's schema",
  );
  assert.ok(transformed.includes('"content_block_stop"'), "stop frame still emitted");
});

test("falls back to the original frames when streamed arguments are not valid JSON", async () => {
  const { reverse } = buildToolNameMaps();
  const frames = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_3","name":"Read","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{broken"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  ].join("");
  const encoder = new TextEncoder();
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  });
  const transformed = await transformResponseStream(new Response(source, { status: 200 }), { reverse }).text();
  assert.ok(transformed.includes('"{broken"'), "raw fragments preserved when they cannot be parsed");
  assert.ok(transformed.includes('"content_block_stop"'), "stop frame still emitted");
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

test("maps Claude Code argument shapes onto OpenCode schemas", () => {
  assert.deepEqual(translateToolInput("read", { file_path: "/a", offset: 2, pages: "1-3" }), {
    path: "/a",
    offset: 2,
  });
  assert.deepEqual(translateToolInput("write", { file_path: "/b", content: "x" }), { path: "/b", content: "x" });
  assert.deepEqual(translateToolInput("edit", { file_path: "/c", old_string: "a", new_string: "b", replace_all: true }), {
    path: "/c",
    oldString: "a",
    newString: "b",
    replaceAll: true,
  });
  assert.deepEqual(translateToolInput("shell", { command: "ls", description: "list", run_in_background: true }), {
    command: "ls",
    background: true,
  });
  assert.deepEqual(
    translateToolInput("grep", { pattern: "x", glob: "*.ts", head_limit: 5, "-i": true, output_mode: "files" }),
    { pattern: "x", include: "*.ts", limit: 5, caseSensitive: false },
  );
  assert.deepEqual(
    translateToolInput("subagent", {
      description: "d",
      prompt: "p",
      subagent_type: "explore",
      run_in_background: true,
      isolation: "worktree",
    }),
    { description: "d", prompt: "p", agent: "explore", background: true },
  );
  assert.deepEqual(translateToolInput("skill", { skill: "pdf", args: "x" }), { id: "pdf" });
  assert.deepEqual(translateToolInput("webfetch", { url: "https://x", prompt: "summarize" }), { url: "https://x" });
  assert.deepEqual(translateToolInput("websearch", { query: "q", allowed_domains: ["a"] }), { query: "q" });
  assert.deepEqual(translateToolInput("question", { questions: [{ question: "q", multiSelect: true }] }), {
    questions: [{ question: "q", multiple: true }],
  });
  assert.deepEqual(translateToolInput("todowrite", { todos: [{ content: "c", status: "pending", activeForm: "doing" }] }), {
    todos: [{ content: "c", status: "pending" }],
  });

  // OpenCode-shaped input is untouched, and the lookup is case-insensitive.
  const native = { path: "/a", offset: 1 };
  assert.deepEqual(translateToolInput("read", native), native);
  assert.deepEqual(translateToolInput("Read", { file_path: "/a" }), { path: "/a" });
  assert.deepEqual(translateToolInput("execute", { code: "1+1" }), { code: "1+1" });
});

test("renames shell and subagent to their Claude Code counterparts", () => {
  const { forward, reverse } = buildToolNameMaps();
  assert.equal(forward.get("shell"), "Bash");
  assert.equal(forward.get("subagent"), "Agent");
  assert.equal(reverse.get("Bash"), "shell");
  assert.equal(reverse.get("Agent"), "subagent");
  assert.equal(reverse.get("Task"), "subagent", "legacy Task name still maps back");
  const custom = buildToolNameMaps({ subagent: "Task" });
  assert.equal(custom.forward.get("subagent"), "Task", "aliases can opt into legacy names");
});

test("derives a stable Claude Code style session id", () => {
  const id = sessionUUID("ses_abc");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(sessionUUID("ses_abc"), id, "deterministic per session");
  assert.notEqual(sessionUUID("ses_xyz"), id);
});

test("sends the Claude Code session header and the updated beta flags", async () => {
  const fresh = { ...expiredOAuth, access: "fresh", expires: Date.now() + 3600_000 };
  const fake = makeContext({ connection: oauthConnection("cred_sid"), credential: fresh });
  await plugin.setup(fake.ctx);
  const request = await fake.request(sampleBody());
  assert.equal(request.headers.get("x-claude-code-session-id"), sessionUUID("ses_test"));
  const beta = request.headers.get("anthropic-beta");
  assert.match(beta, /thinking-token-count-2026-05-13/);
  assert.match(beta, /context-management-2025-06-27/);
  assert.match(beta, /oauth-2025-04-20/);
});

test("parses retry-after values", () => {
  assert.equal(parseRetryAfter("7"), 7000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter("not-a-date"), null);
  const parsed = parseRetryAfter(new Date(Date.now() + 5000).toUTCString());
  assert.ok(parsed > 3000 && parsed <= 5000, "http-date parsed");
});

test("reuses retry-after hints in OpenCode's retry hook", async () => {
  const fake = makeContext({ connection: keyConnection, credential: { type: "key", key: "k" } });
  await plugin.setup(fake.ctx);
  assert.deepEqual(await fake.retry({ status: 429, type: "rate_limit", message: "429" }), { retry: false });
  await fake.respond(new Response(null, { status: 429, headers: { "retry-after": "12" } }));
  assert.deepEqual(await fake.retry({ status: 429, type: "rate_limit", message: "429" }), { retry: true, delay: 12000 });
  await fake.respond(new Response(null, { status: 200 }));
  assert.deepEqual(
    await fake.retry({ status: 429, type: "rate_limit", message: "429" }),
    { retry: false },
    "a success clears the stored hint",
  );
});

test("translates Claude Code arguments through the tool hook", async () => {
  const fake = makeContext({ connection: keyConnection, credential: { type: "key", key: "k" } });
  await plugin.setup(fake.ctx);
  assert.deepEqual(await fake.toolBefore("read", { file_path: "/x" }), { path: "/x" });
  assert.deepEqual(await fake.toolBefore("read", { path: "/x" }), { path: "/x" });
});
