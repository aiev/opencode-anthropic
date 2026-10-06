#!/usr/bin/env node
// Capture the request a local Claude Code installation sends, using a mock
// endpoint and an isolated config dir. Nothing leaves the machine: the CLI is
// pointed at 127.0.0.1 with a dummy token, so no account or real API is used.
//
//   node scripts/claude-capture.mjs                      # capture + summarize
//   node scripts/claude-capture.mjs --compare A.json B.json
//
// The capture needs `claude` on PATH (override with --binary). Compare files
// can be a Claude capture, an OpenCode `ANTHROPIC_OAUTH_DUMP` JSONL file, or
// any JSON/JSONL entry with a `body`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

function readRequestFile(file) {
  const text = fs.readFileSync(file, "utf8");
  try {
    const parsed = JSON.parse(text);
    if (parsed?.body) return parsed;
  } catch {}
  const entries = [];
  for (const line of text.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.body) entries.push(parsed);
    } catch {}
  }
  return entries.find((entry) => Array.isArray(entry.body?.tools) && entry.body.tools.length) ?? entries.at(-1) ?? null;
}

function summarize(request) {
  const body = request?.body ?? {};
  const headers = request?.headers ?? {};
  const lines = [
    `url: ${request?.url ?? "?"}`,
    `model: ${body.model} | max_tokens: ${body.max_tokens} | stream: ${body.stream}`,
    `user-agent: ${headers["user-agent"]}`,
    `anthropic-beta: ${headers["anthropic-beta"]}`,
    `thinking: ${JSON.stringify(body.thinking)}`,
    `system blocks: ${Array.isArray(body.system) ? body.system.length : 0}`,
    `tools (${(body.tools ?? []).length}):`,
  ];
  for (const tool of body.tools ?? []) {
    const properties = Object.keys(tool.input_schema?.properties ?? {});
    const required = tool.input_schema?.required ?? [];
    lines.push(`  ${tool.name} [${properties.join(", ")}] required=[${required.join(", ")}]`);
  }
  return lines.join("\n");
}

function compare(firstPath, secondPath) {
  let first;
  let second;
  try {
    first = readRequestFile(firstPath);
    second = readRequestFile(secondPath);
  } catch (error) {
    console.error(`compare: ${error?.message ?? error}`);
    process.exitCode = 1;
    return;
  }
  if (!first || !second) {
    console.error("compare: both files need a request with a body");
    process.exitCode = 1;
    return;
  }
  console.log(`A: ${firstPath}\n${summarize(first)}\n`);
  console.log(`B: ${secondPath}\n${summarize(second)}\n`);
  const byName = (request) => new Map((request.body?.tools ?? []).map((tool) => [String(tool.name).toLowerCase(), tool]));
  const a = byName(first);
  const b = byName(second);
  const onlyA = [...a.keys()].filter((name) => !b.has(name));
  const onlyB = [...b.keys()].filter((name) => !a.has(name));
  console.log(`only in A: ${onlyA.join(", ") || "-"}`);
  console.log(`only in B: ${onlyB.join(", ") || "-"}`);
  console.log("shared tools with different argument keys:");
  for (const [name, toolA] of a) {
    const toolB = b.get(name);
    if (!toolB) continue;
    const keysA = Object.keys(toolA.input_schema?.properties ?? {}).sort().join(",");
    const keysB = Object.keys(toolB.input_schema?.properties ?? {}).sort().join(",");
    if (keysA !== keysB) console.log(`  ${name}: A[${keysA}] B[${keysB}]`);
  }
}

if (args.includes("--compare")) {
  const files = args.filter((arg) => arg !== "--compare" && !arg.startsWith("--"));
  compare(files[0], files[1]);
} else {
  const outDir = option("--out", path.join(os.tmpdir(), "opencode-claude-capture"));
  const model = option("--model", "claude-sonnet-4-5");
  const prompt = option("--prompt", "Say hi in one word");
  const port = Number(option("--port", "8791"));
  const binary = option("--binary", "claude");

  fs.rmSync(path.join(outDir, "config"), { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const requests = [];

  const sse = (response, events) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [name, data] of events) response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    response.end();
  };

  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = body;
      }
      const record = { url: request.url, headers: request.headers, body: parsed };
      requests.push(record);
      if (request.url.includes("count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      sse(response, [
        ["message_start", { type: "message_start", message: { id: "msg_capture", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
    });
  });

  server.listen(port, "127.0.0.1", async () => {
    const child = spawn(binary, ["-p", "--model", model, prompt], {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: path.join(outDir, "config"),
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_AUTH_TOKEN: "capture-dummy",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const killer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    const code = await new Promise((resolve) => child.on("close", resolve));
    clearTimeout(killer);
    server.close();

    requests.forEach((request, index) => {
      fs.writeFileSync(path.join(outDir, `request-${index + 1}.json`), JSON.stringify(request, null, 2));
    });
    const useful = requests.find((request) => request.body?.tools?.length) ?? requests.at(-1);
    console.log(`claude exited with ${code}; ${requests.length} request(s) captured in ${outDir}`);
    if (stdout.trim()) console.log(`stdout: ${stdout.trim().slice(0, 500)}`);
    if (stderr.trim()) console.log(`stderr: ${stderr.trim().slice(0, 1000)}`);
    if (useful) console.log(`\n${summarize(useful)}`);
  });
}
