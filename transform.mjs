// Request and response transforms that make OpenCode's Anthropic traffic look
// like a Claude Code session: the identity system block, Claude Code tool
// names on the way out, and the original names on the way back.
export const SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

// Canonical Claude Code tool names. OpenCode registers tools with lowercase
// names, so requests are renamed to this casing and responses are renamed
// back before OpenCode executes them.
export const CC_TOOL_NAMES = [
  "AskUserQuestion",
  "Bash",
  "Edit",
  "EnterPlanMode",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillShell",
  "NotebookEdit",
  "Read",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
];

// OpenCode tools whose names do not match the lowercase form of their Claude
// Code counterpart.
const DEFAULT_ALIASES = {
  question: "AskUserQuestion",
};

export function parseAliases(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function buildToolNameMaps(aliases = {}) {
  const forward = new Map(); // lowercase request name -> Claude Code name
  const reverse = new Map(); // Claude Code name -> request name
  for (const name of CC_TOOL_NAMES) {
    forward.set(name.toLowerCase(), name);
    reverse.set(name, name.toLowerCase());
  }
  for (const [from, to] of Object.entries({ ...DEFAULT_ALIASES, ...aliases })) {
    if (typeof from !== "string" || typeof to !== "string" || !from || !to) continue;
    forward.set(from.toLowerCase(), to);
    reverse.set(to, from.toLowerCase());
  }
  return { forward, reverse };
}

function renameToolUseBlock(block, map) {
  if (
    block &&
    typeof block === "object" &&
    block.type === "tool_use" &&
    typeof block.name === "string" &&
    map.has(block.name)
  ) {
    return { ...block, name: map.get(block.name) };
  }
  return block;
}

export function transformRequestBody(raw, { systemMode = "prepend", renameTools = true, forward } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const first = Array.isArray(parsed.system) ? parsed.system[0] : undefined;
  const hasIdentity =
    first && typeof first === "object" && typeof first.text === "string" && first.text.startsWith("You are Claude Code");
  if (!hasIdentity && systemMode !== "off") {
    const identity = { type: "text", text: SYSTEM_IDENTITY };
    if (Array.isArray(parsed.system) && parsed.system.length > 0) {
      parsed.system =
        systemMode === "replace"
          ? [{ ...parsed.system[0], text: SYSTEM_IDENTITY }, ...parsed.system.slice(1)]
          : [identity, ...parsed.system];
    } else {
      parsed.system = [identity];
    }
  }
  if (renameTools) {
    const map = forward ?? buildToolNameMaps().forward;
    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => ({ ...tool, name: map.get(String(tool?.name ?? "").toLowerCase()) ?? tool?.name }));
    }
    if (Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((message) => {
        if (!Array.isArray(message?.content)) return message;
        return { ...message, content: message.content.map((block) => renameToolUseBlock(block, map)) };
      });
    }
  }
  return JSON.stringify(parsed);
}

function renameToolUsePayload(parsed, reverse) {
  if (!parsed || typeof parsed !== "object") return false;
  let changed = false;
  const rename = (block) => {
    if (
      block &&
      typeof block === "object" &&
      block.type === "tool_use" &&
      typeof block.name === "string" &&
      reverse.has(block.name)
    ) {
      block.name = reverse.get(block.name);
      changed = true;
    }
  };
  if (parsed.type === "content_block_start") rename(parsed.content_block);
  if (Array.isArray(parsed.content)) parsed.content.forEach(rename);
  if (parsed.message && Array.isArray(parsed.message.content)) parsed.message.content.forEach(rename);
  return changed;
}

// Rewrites one complete SSE frame, or one non-streaming JSON body. Only
// `tool_use` names are touched; tool arguments (`partial_json`), text, and
// everything else are preserved byte for byte.
export function rewriteEvent(eventText, reverse) {
  let changed = false;
  const lines = eventText.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).replace(/^ /, "");
    if (!payload || payload === "[DONE]") continue;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!renameToolUsePayload(parsed, reverse)) continue;
    changed = true;
    lines[index] = `data: ${JSON.stringify(parsed)}`;
  }
  if (changed) return lines.join("\n");
  if (!eventText.includes("data:")) {
    const trimmed = eventText.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (renameToolUsePayload(parsed, reverse)) return JSON.stringify(parsed);
      } catch {}
    }
  }
  return eventText;
}

export function transformResponseStream(response, reverse) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const stream = new ReadableStream({
    async pull(controller) {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const frame = buffer.slice(0, boundary + 2);
          buffer = buffer.slice(boundary + 2);
          controller.enqueue(encoder.encode(rewriteEvent(frame, reverse)));
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          if (buffer) {
            controller.enqueue(encoder.encode(rewriteEvent(buffer, reverse)));
            buffer = "";
          }
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
