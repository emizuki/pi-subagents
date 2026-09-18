import { chmodSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export function writeFakePi(binDir: string): string {
	const fakePi = path.join(binDir, "pi");
	const extensionUrl = pathToFileURL(
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/subagents/index.ts"),
	).href;
	writeFileSync(
		fakePi,
		`#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (process.env.FAKE_PI_CAPTURE) appendFileSync(process.env.FAKE_PI_CAPTURE, JSON.stringify(args) + "\\n");
if (process.env.FAKE_PI_CWD_CAPTURE) appendFileSync(process.env.FAKE_PI_CWD_CAPTURE, process.cwd() + "\\n");
if (process.env.FAKE_PI_ENV_CAPTURE) appendFileSync(process.env.FAKE_PI_ENV_CAPTURE, JSON.stringify({
  depth: process.env.PI_SUBAGENT_DEPTH ?? null,
  runtime: process.env.PI_SUBAGENT_RUNTIME_V1 ?? null,
  ipc: process.env.PI_SUBAGENT_IPC_DIR ?? null,
  owner: process.env.PI_SUBAGENT_OWNER_PID ?? null,
  agent: process.env.PI_SUBAGENT_AGENT ?? null,
  pid: process.pid,
  // Process-group id, for Task 8's detached regression. Linux only; null everywhere else, which
  // is what that test skips on. Read from the child itself rather than raced for from the parent:
  // by the time the parent could open /proc/<pid>/stat the fake has usually already exited.
  // comm (field 2) is parenthesised and may itself contain spaces and parens, so parse after the
  // LAST ")" — splitting the whole line on spaces gets the wrong field for a process named "a b".
  pgrp: (() => {
    try {
      const stat = readFileSync("/proc/self/stat", "utf8");
      return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
    } catch { return null; }
  })(),
}) + "\\n");
if (process.env.FAKE_PI_CONCURRENCY_CAPTURE) appendFileSync(process.env.FAKE_PI_CONCURRENCY_CAPTURE, "start\\n");
const sessionDirIndex = args.indexOf("--session-dir");
if (sessionDirIndex !== -1) {
  const sessionDir = args[sessionDirIndex + 1];
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(sessionDir, "fake-" + process.pid + ".jsonl"), JSON.stringify({ type: "session", version: 3, id: "fake" }) + "\\n");
}
if (process.env.FAKE_PI_MODE === "sigkill") process.kill(process.pid, "SIGKILL");
if (process.env.FAKE_PI_MODE === "wait") setInterval(() => {}, 1000);
if (process.env.FAKE_PI_MODE === "delegate" && process.env.PI_SUBAGENT_RUNTIME_V1) {
  const handlers = new Map();
  const tools = new Map();
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    unregisterTool(name) {
      tools.delete(name);
    },
  };
  const extension = (await import(${JSON.stringify(extensionUrl)})).default;
  extension(pi);
  const model = {
    provider: "fake-provider",
    id: "fake-model",
    name: "Fake",
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const context = {
    cwd: process.cwd(),
    model,
    thinkingLevel: "off",
    scopedModels: [],
    modelRegistry: {
      getAvailable: () => [model],
      find: () => model,
    },
    sessionManager: { getSessionFile: () => undefined },
    hasUI: false,
    isProjectTrusted: () => false,
    ui: { notify: () => {}, input: async () => undefined, confirm: async () => true },
  };
  for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
  const subagent = tools.get("subagent");
  if (!subagent) throw new Error("delegate mode requires the nested subagent tool");
  await subagent.execute("delegate-call", { agent: "recon", task: "nested probe" }, new AbortController().signal, undefined, context);
}
let content;
if (process.env.FAKE_PI_MODE === "multi-text") {
  content = [{ type: "text", text: "first" }, { type: "text", text: "second" }];
} else {
  content = [{ type: "text", text: process.env.FAKE_PI_TEXT ?? "ok" }];
}
const events = process.env.FAKE_PI_MODE === "empty-final"
  ? [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "stale" }], stopReason: "toolUse" } },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "end" } },
    ]
  : [{ type: "message_end", message: { role: "assistant", content, stopReason: "end" } }];
const bytes = Buffer.from(events.map((event) => JSON.stringify(event)).join("\\n") + "\\n", "utf8");
const emit = () => {
  if (process.env.FAKE_PI_CONCURRENCY_CAPTURE) appendFileSync(process.env.FAKE_PI_CONCURRENCY_CAPTURE, "end\\n");
  if (process.env.FAKE_PI_MODE === "split-utf8") {
    const emoji = Buffer.from("🙂", "utf8");
    const start = bytes.indexOf(emoji);
    process.stdout.write(bytes.subarray(0, start + 2));
    setTimeout(() => process.stdout.write(bytes.subarray(start + 2)), 20);
  } else {
    process.stdout.write(bytes);
  }
};
const holdMs = Number(process.env.FAKE_PI_HOLD_MS ?? 0);
if (holdMs > 0) setTimeout(emit, holdMs); else emit();
`,
	);
	chmodSync(fakePi, 0o755);
	return fakePi;
}
