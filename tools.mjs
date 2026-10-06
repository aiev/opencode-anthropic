// Explicit tool-compatibility table.
//
// Only OpenCode tools whose semantics line up with a Claude Code counterpart
// are exposed under a Claude Code name. OpenCode-only tools (compress,
// todoread, execute/Code Mode) are deliberately left alone.
//
// Each mapped tool may also translate the argument shapes a Claude-Code
// model is likely to produce (its training priors: snake_case keys,
// `file_path`, `run_in_background`, ...) back onto OpenCode's own schemas.
// Translation is conservative: unknown keys are kept, a mapped key is only
// renamed when the OpenCode-shaped key is not already present.

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function renameKeys(input, mapping, drop = []) {
  if (!isPlainObject(input)) return input;
  const output = { ...input };
  for (const [from, to] of Object.entries(mapping)) {
    if (has(output, from)) {
      if (!has(output, to)) output[to] = output[from];
      delete output[from];
    }
  }
  for (const key of drop) delete output[key];
  return output;
}

export const TOOL_COMPAT = {
  read: {
    cc: "Read",
    translate: (input) => renameKeys(input, { file_path: "path" }, ["pages"]),
  },
  write: {
    cc: "Write",
    translate: (input) => renameKeys(input, { file_path: "path" }),
  },
  edit: {
    cc: "Edit",
    translate: (input) =>
      renameKeys(input, {
        file_path: "path",
        old_string: "oldString",
        new_string: "newString",
        replace_all: "replaceAll",
      }),
  },
  shell: {
    cc: "Bash",
    translate: (input) =>
      renameKeys(input, { run_in_background: "background" }, ["description", "dangerouslyDisableSandbox"]),
  },
  glob: {
    cc: "Glob",
  },
  grep: {
    cc: "Grep",
    translate: (input) => {
      const renamed = renameKeys(input, { glob: "include", head_limit: "limit" }, [
        "-n",
        "-A",
        "-B",
        "-C",
        "output_mode",
        "multiline",
        "type",
        "offset",
      ]);
      if (!isPlainObject(renamed)) return renamed;
      if (has(renamed, "-i")) {
        if (!has(renamed, "caseSensitive")) renamed.caseSensitive = !renamed["-i"];
        delete renamed["-i"];
      }
      return renamed;
    },
  },
  webfetch: {
    cc: "WebFetch",
    // OpenCode's webfetch only converts a URL to a format; Claude Code's
    // extra `prompt` argument has no equivalent and cannot be honoured.
    translate: (input) => renameKeys(input, {}, ["prompt"]),
  },
  websearch: {
    cc: "WebSearch",
    // Domain filters are not part of OpenCode's websearch tool.
    translate: (input) => renameKeys(input, {}, ["allowed_domains", "blocked_domains"]),
  },
  skill: {
    cc: "Skill",
    translate: (input) => renameKeys(input, { skill: "id" }, ["args"]),
  },
  question: {
    cc: "AskUserQuestion",
    translate: (input) => {
      if (!isPlainObject(input) || !Array.isArray(input.questions)) return input;
      return {
        ...input,
        questions: input.questions.map((question) => {
          if (!isPlainObject(question)) return question;
          const next = { ...question };
          if (has(next, "multiSelect") && !has(next, "multiple")) next.multiple = next.multiSelect;
          delete next.multiSelect;
          return next;
        }),
      };
    },
  },
  subagent: {
    cc: "Agent",
    legacy: ["Task"],
    translate: (input) =>
      renameKeys(input, { subagent_type: "agent", run_in_background: "background" }, ["isolation"]),
  },
  todowrite: {
    cc: "TodoWrite",
    translate: (input) => {
      if (!isPlainObject(input) || !Array.isArray(input.todos)) return input;
      return {
        ...input,
        todos: input.todos.map((todo) => {
          if (!isPlainObject(todo)) return todo;
          const next = { ...todo };
          delete next.activeForm;
          return next;
        }),
      };
    },
  },
};

export function translateToolInput(toolID, input) {
  const key = String(toolID ?? "").toLowerCase();
  const entry = TOOL_COMPAT[key];
  if (!entry?.translate) return input;
  return entry.translate(input);
}

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

// `aliases` maps an OpenCode tool id to the Claude Code name it should be
// exposed as. It can override a default mapping (`{ subagent: "Task" }` for
// the legacy name) or add a mapping for a tool this table does not know.
export function buildToolNameMaps(aliases = {}) {
  const forward = new Map(); // OpenCode tool id -> Claude Code name
  const reverse = new Map(); // Claude Code name -> OpenCode tool id
  for (const [toolID, entry] of Object.entries(TOOL_COMPAT)) {
    forward.set(toolID, entry.cc);
    reverse.set(entry.cc, toolID);
    for (const legacy of entry.legacy ?? []) reverse.set(legacy, toolID);
  }
  for (const [from, to] of Object.entries(aliases)) {
    if (typeof from !== "string" || typeof to !== "string" || !from || !to) continue;
    const toolID = from.toLowerCase();
    forward.set(toolID, to);
    reverse.set(to, toolID);
  }
  return { forward, reverse };
}

export const CC_TOOL_NAMES = Object.values(TOOL_COMPAT).map((entry) => entry.cc);
