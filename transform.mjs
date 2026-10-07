// Request and response transforms that make OpenCode's Anthropic traffic look
// like a Claude Code session: the identity system block, Claude Code tool
// names on the way out, and the original names on the way back.
//
// Argument translation (Claude Code argument shapes -> OpenCode schemas) is
// table-driven in tools.mjs. It runs while the response is rewritten, before
// OpenCode parses a tool call: the `input_json_delta` fragments of a mapped
// tool are held until the block closes, translated as one JSON object, and
// re-emitted as a single delta. When nothing changes, the original frames are
// passed through byte for byte.
import { createHash } from "node:crypto";
import { TOOL_COMPAT, buildToolNameMaps, translateToolInput } from "./tools.mjs";

export { CC_TOOL_NAMES, TOOL_COMPAT, buildToolNameMaps, parseAliases, translateToolInput } from "./tools.mjs";

// Current Claude Code identity line (2.1.x, Agent SDK wording). The 2025
// wording is kept for routes that still expect it: select it with
// ANTHROPIC_OAUTH_SYSTEM_IDENTITY or the plugin `identity` option.
export const SYSTEM_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
export const LEGACY_SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const IDENTITY_PREFIXES = ["You are a Claude agent", "You are Claude Code"];

// A stable, Claude-Code-shaped UUID for an OpenCode session. Claude Code
// sends `x-claude-code-session-id: <uuid>`; deriving it from the OpenCode
// session id keeps every request of one session correlated without
// fabricating a device identity.
export function sessionUUID(sessionID) {
  const hash = createHash("sha1").update(`opencode-anthropic:${sessionID}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function isToolUseBlock(block) {
  return Boolean(block) && typeof block === "object" && block.type === "tool_use";
}

function renameToolUseBlock(block, map) {
  if (isToolUseBlock(block) && typeof block.name === "string" && map.has(block.name)) {
    return { ...block, name: map.get(block.name) };
  }
  return block;
}

function shapeSystem(parsed, { systemMode, identity, billing }) {
  const blocks = Array.isArray(parsed.system) ? parsed.system : [];
  if (blocks.length === 0 && (!billing || systemMode === "off")) return blocks;
  const first = blocks[0];
  const firstText = first && typeof first === "object" && typeof first.text === "string" ? first.text : "";
  const secondText =
    firstText.startsWith("x-anthropic-billing-header") &&
    blocks[1] &&
    typeof blocks[1] === "object" &&
    typeof blocks[1].text === "string"
      ? blocks[1].text
      : "";
  const hasIdentity = IDENTITY_PREFIXES.some(
    (prefix) => firstText.startsWith(prefix) || secondText.startsWith(prefix),
  );
  const prefix = [];
  if (billing && systemMode !== "off") prefix.push({ type: "text", text: billing });
  if (systemMode !== "off" && !hasIdentity) {
    if (systemMode === "replace" && blocks.length > 0) {
      return [...prefix, { ...blocks[0], text: identity }, ...blocks.slice(1)];
    }
    prefix.push({ type: "text", text: identity });
  }
  return [...prefix, ...blocks];
}

export function transformRequestBody(
  raw,
  {
    systemMode = "prepend",
    renameTools = true,
    forward,
    identity = SYSTEM_IDENTITY,
    billing = null,
    metadataUserId = null,
    thinking = true,
  } = {},
) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const shaped = shapeSystem(parsed, { systemMode, identity, billing });
  if (shaped.length > 0 || Array.isArray(parsed.system)) parsed.system = shaped;

  if (metadataUserId && !parsed.metadata?.user_id) {
    parsed.metadata = { ...parsed.metadata, user_id: metadataUserId };
  }

  const claudeModel = /claude-(sonnet|opus)/i.test(String(parsed.model ?? ""));
  if (thinking && claudeModel) {
    if (
      parsed.thinking === undefined &&
      typeof parsed.max_tokens === "number" &&
      parsed.max_tokens > 1024
    ) {
      parsed.thinking = { type: "enabled", budget_tokens: parsed.max_tokens - 1, display: "omitted" };
    }
    if (parsed.context_management === undefined && parsed.thinking !== undefined) {
      parsed.context_management = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
    }
  }

  if (renameTools) {
    const map = forward ?? buildToolNameMaps().forward;
    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => ({
        ...tool,
        name: map.get(String(tool?.name ?? "").toLowerCase()) ?? tool?.name,
      }));
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

// The response rewriter is stateful: tool use blocks can be split across
// frames, so argument translation has to remember what it has seen for each
// content block index.
export function createResponseRewriter({ reverse, translateInput = translateToolInput } = {}) {
  const pending = new Map(); // content block index -> { name, frames, json }

  function rewriteToolBlocks(blocks) {
    let changed = false;
    for (const block of blocks) {
      if (!isToolUseBlock(block)) continue;
      if (typeof block.name === "string" && reverse?.has(block.name)) {
        block.name = reverse.get(block.name);
        changed = true;
      }
      const entry = TOOL_COMPAT[String(block.name ?? "").toLowerCase()];
      if (
        entry?.translate &&
        block.input &&
        typeof block.input === "object" &&
        Object.keys(block.input).length > 0
      ) {
        const mapped = translateInput(block.name, block.input);
        if (JSON.stringify(mapped) !== JSON.stringify(block.input)) {
          block.input = mapped;
          changed = true;
        }
      }
    }
    return changed;
  }

  function rewriteBody(parsed) {
    let changed = false;
    if (Array.isArray(parsed?.content)) changed = rewriteToolBlocks(parsed.content) || changed;
    if (parsed?.message && Array.isArray(parsed.message.content)) {
      changed = rewriteToolBlocks(parsed.message.content) || changed;
    }
    return changed;
  }

  // Returns a list of frames to emit (empty list = suppress this frame).
  function rewriteFrame(frame) {
    if (!frame.includes("data:")) {
      const trimmed = frame.trim();
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (rewriteBody(parsed)) return [JSON.stringify(parsed)];
        } catch {}
      }
      return [frame];
    }

    const lines = frame.split("\n");
    const emitted = [];
    let changed = false;
    let suppress = false;
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

      if (parsed?.type === "content_block_start" && parsed.content_block) {
        const blockChanged = rewriteToolBlocks([parsed.content_block]);
        const block = parsed.content_block;
        if (isToolUseBlock(block)) {
          const entry = TOOL_COMPAT[String(block.name ?? "").toLowerCase()];
          if (entry?.translate) {
            pending.set(parsed.index, { name: String(block.name).toLowerCase(), frames: [], json: [] });
          }
        }
        if (blockChanged) {
          lines[index] = `data: ${JSON.stringify(parsed)}`;
          changed = true;
        }
        continue;
      }

      if (parsed?.type === "content_block_delta" && parsed.delta?.type === "input_json_delta") {
        const state = pending.get(parsed.index);
        if (state) {
          state.frames.push(frame);
          state.json.push(String(parsed.delta.partial_json ?? ""));
          suppress = true;
          continue;
        }
      }

      if (parsed?.type === "content_block_stop" && pending.has(parsed.index)) {
        const state = pending.get(parsed.index);
        pending.delete(parsed.index);
        const frames = [];
        let synthesized = null;
        if (state.json.length > 0) {
          try {
            const input = JSON.parse(state.json.join(""));
            const mapped = translateInput(state.name, input);
            if (JSON.stringify(mapped) !== JSON.stringify(input)) {
              synthesized = `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: parsed.index,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(mapped) },
              })}\n\n`;
            }
          } catch {}
        }
        if (synthesized) frames.push(synthesized);
        else frames.push(...state.frames);
        frames.push(frame);
        return frames;
      }

      if (rewriteBody(parsed)) {
        lines[index] = `data: ${JSON.stringify(parsed)}`;
        changed = true;
      }
    }

    if (suppress) return [];
    return changed ? [lines.join("\n")] : [frame];
  }

  return {
    rewriteFrame,
    // Emit anything still buffered for a truncated stream, so a missing
    // content_block_stop can never swallow tool arguments.
    flush() {
      const frames = [];
      for (const state of pending.values()) frames.push(...state.frames);
      pending.clear();
      return frames;
    },
  };
}

// Rewrites one complete SSE frame, or one non-streaming JSON body, touching
// only `tool_use` names. Kept for callers that only need name mapping.
export function rewriteEvent(eventText, reverse) {
  const rewriter = createResponseRewriter({
    reverse,
    translateInput: (_name, input) => input,
  });
  return rewriter.rewriteFrame(eventText).join("");
}

export function transformResponseStream(response, options = {}) {
  if (!response.body) return response;
  const rewriter = createResponseRewriter(options);
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
          const pieces = rewriter.rewriteFrame(frame);
          for (const piece of pieces) controller.enqueue(encoder.encode(piece));
          if (pieces.length > 0) return;
          continue; // suppressed frame: keep draining instead of stalling
        }
        const { done, value } = await reader.read();
        if (done) {
          if (buffer) {
            for (const piece of rewriter.rewriteFrame(buffer)) controller.enqueue(encoder.encode(piece));
            buffer = "";
          }
          for (const piece of rewriter.flush()) controller.enqueue(encoder.encode(piece));
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
