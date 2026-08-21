import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { detectRuntimeContext, type HostProbeRunner } from "../src/runtime-host-detect.ts";
import { getRuntimeProvider, validateAgentRuntimeContext } from "../src/agent-runtime-context.ts";
import habitat, { DEFAULT_SESSION_PLACEMENT, HANDOFF_COMMAND, MAX_RUNTIME_FRAGMENT_LENGTH, PLAN_IMPLEMENT_SHORT_COMMAND, PROMOTE_CONTEXT_COMMAND, SAVE_SESSION_COMMAND, compactRuntimeFragment, nextHandoffTitle, normalizeSessionToolInput } from "../extensions/agent-runtime-habitat.ts";

interface ToolResult { content: Array<{ type: string; text: string }>; details: unknown }
interface ToolSpec { name: string; label: string; description: string; approval: "read" | "write"; parameters: Record<string, unknown>; execute: (id: string, params: unknown, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => Promise<ToolResult> }
interface CommandSpec { description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void }
interface PluginApi { on: (event: string, handler: Function) => void; registerTool: (definition: ToolSpec) => void; registerCommand: (name: string, definition: CommandSpec) => void; sendUserMessage: (content: string) => void; getThinkingLevel: () => string; getSessionName: () => string | undefined; setSessionName: (name: string) => Promise<void>; pi: { getAgentDir: () => string } }
const env = { TERM_PROGRAM: "WezTerm", WEZTERM_PANE: "42", WEZTERM_UNIX_SOCKET: "\\\\?\\pipe\\wez" };
const listed = JSON.stringify([{ pane_id: 42, window_id: 7, tab_id: 8, workspace: "ws", cwd: "C:\\dev\\omp" }]);

const detect = (overrides: Record<string, string | undefined> = {}, stdout = listed, status = 0, runner?: HostProbeRunner) => detectRuntimeContext({ env: { ...env, ...overrides }, run: runner ?? (async () => ({ status, stdout })) });

test("detects valid OMP + WezTerm context without secrets", async () => {
  const value = await detect();
  expect(value).toEqual({ version: 1, harness: { id: "omp", hasUI: false }, host: { kind: "terminal", provider: "WezTerm", trust: "validated-local-probe" }, location: { instanceRef: "\\\\?\\pipe\\wez", windowId: "7", tabId: "8", paneId: "42", workspace: "ws", cwd: "C:\\dev\\omp" }, capabilities: {} });
  expect(JSON.stringify(value)).not.toContain("TOKEN");
  expect(JSON.stringify(value)).not.toContain("SECRET");
  expect(JSON.stringify(value)).not.toContain("WEZTERM_UNIX_SOCKET");
});

test("degrades to unknown for missing pane, socket, invalid list JSON, and stale pane", async () => {
  for (const overrides of [{ WEZTERM_PANE: undefined }, { WEZTERM_UNIX_SOCKET: undefined }]) expect((await detect(overrides)).host.kind).toBe("unknown");
  expect((await detect({}, "not json")).host.kind).toBe("unknown");
  expect((await detect({}, JSON.stringify([{ pane_id: 99 }]))).host.kind).toBe("unknown");
});
test("degrades on nonzero probe status", async () => { expect((await detect({}, listed, 1)).host.kind).toBe("unknown"); });
test("runner receives executable argv, timeout, selected env, and cwd", async () => {
  let received: readonly string[] = []; let timeout = 0; let receivedEnv: Record<string,string|undefined> | undefined; let receivedCwd: string | undefined;
  await detect({}, listed, 0, async (argv, options) => { received = argv; timeout = options?.timeoutMs ?? 0; receivedEnv = options?.env; receivedCwd = options?.cwd; return { status: 0, stdout: listed }; });
  expect(received).toEqual(["wezterm", "cli", "list", "--format", "json"]); expect(timeout).toBe(5000); expect(receivedEnv?.WEZTERM_UNIX_SOCKET).toBe(env.WEZTERM_UNIX_SOCKET); expect(receivedCwd).toBeUndefined();
});
test("normalizes file cwd and rejects non-file cwd URLs", async () => {
  const fileListed = JSON.stringify([{ pane_id: 42, window_id: 7, tab_id: 8, cwd: "file:///C:/dev/omp" }]);
  expect((await detect({}, fileListed)).location?.cwd).toBe("C:\\dev\\omp");
  expect((await detect({}, JSON.stringify([{ pane_id: 42, window_id: 7, tab_id: 8, cwd: "https://example.test/work" }]))).host.kind).toBe("unknown");
});
test("validates enum values and rejects unknown fields", () => {
  expect(() => validateAgentRuntimeContext({ version: 1, harness: { id: "omp", hasUI: false }, host: { kind: "invalid", provider: "x", trust: "validated-local-probe" }, capabilities: {} })).toThrow();
  expect(() => validateAgentRuntimeContext({ version: 1, harness: { id: "omp", hasUI: false }, host: { kind: "terminal", provider: "x", trust: "validated-local-probe" }, capabilities: {}, extra: true })).toThrow();
});
test("provider registry returns undefined for unknown providers", () => { expect(getRuntimeProvider("mystery")).toBeUndefined(); });

test("extension registers context and an explicit nested launch contract", async () => {
  const agentDir = await mkdtemp(`${tmpdir()}${"/omp-agent-runtime-"}`);
  try {
    const handlers: Record<string, Function> = {};
    const tools = new Map<string, ToolSpec>();
    const commands = new Map<string, CommandSpec>();
    const sentMessages: string[] = [];
    let sessionName: string | undefined = "OMP Habitat";
    const pi: PluginApi = { on(event, handler) { handlers[event] = handler; }, registerTool(definition) { tools.set(definition.name, definition); }, registerCommand(name, definition) { commands.set(name, definition); }, sendUserMessage(content) { sentMessages.push(content); }, getThinkingLevel: () => "medium", getSessionName: () => sessionName, setSessionName: async name => { sessionName = name; }, pi: { getAgentDir: () => agentDir } };
    habitat(pi as unknown as Parameters<typeof habitat>[0]);
    const contextTool = tools.get("agent_runtime_context");
    const sessionTool = tools.get("agent_runtime_session");
    expect(contextTool?.approval).toBe("read");
    expect(sessionTool?.approval).toBe("write");
    const schema = sessionTool!.parameters as { required?: string[]; properties?: Record<string, { anyOf?: unknown[]; required?: string[] }> };
    expect(schema.required).toEqual(["cwd", "prompt", "pane", "fresh", "persistence", "model", "focus"]);
    expect(schema.properties?.placement.anyOf).toHaveLength(2);
    expect(DEFAULT_SESSION_PLACEMENT).toEqual({ kind: "split", direction: "right", percent: 50 });
    expect(normalizeSessionToolInput({
      cwd: "C:\\dev\\omp",
      prompt: "implement",
      pane: { title: "Implementador", onExit: "keep-open" },
      fresh: true,
      persistence: "saved",
      model: { mode: "inherit" },
      focus: false,
    }).placement).toEqual(DEFAULT_SESSION_PLACEMENT);
    expect(schema.properties?.pane.required).toEqual(["title", "onExit"]);
    expect(schema.properties?.model.anyOf).toHaveLength(2);
    const planCommand = commands.get(PLAN_IMPLEMENT_SHORT_COMMAND);
    expect(planCommand?.description).toContain("right split");
    await planCommand!.handler('corregir "framing"', {});
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain(JSON.stringify('corregir "framing"'));
    expect(sentMessages[0]).toContain('placement {kind:"split",direction:"right",percent:50}');
    expect(sentMessages[0]).toContain('pane {title:"Implementador · <objetivo corto>",onExit:"keep-open"}');
    expect(sentMessages[0]).toContain('model:{mode:"inherit"}');
    expect(sentMessages[0]).toContain("No implementes aquí");
    await planCommand!.handler("   ", {});
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1]).toContain("solicitud de usuario accionable inmediatamente anterior");
    const promoteCommand = commands.get(PROMOTE_CONTEXT_COMMAND);
    expect(promoteCommand?.description).toContain("durable session context");
    await promoteCommand!.handler('decisión de "framing"', {});
    expect(sentMessages).toHaveLength(3);
    expect(sentMessages[2]).toContain(JSON.stringify('decisión de "framing"'));
    expect(sentMessages[2]).toContain("decisiones y sus razones a Decisions");
    expect(sentMessages[2]).toContain("No guardes transcripts");
    expect(sentMessages[2]).toContain("Si no hay delta durable, no edites archivos");
    await promoteCommand!.handler(" ", {});
    expect(sentMessages).toHaveLength(4);
    expect(sentMessages[3]).toContain("Revisá toda la sesión");
    const saveSessionCommand = commands.get(SAVE_SESSION_COMMAND);
    expect(saveSessionCommand?.description).toContain("deltas durables");
    await saveSessionCommand!.handler('Zulip y "Event Router"', {});
    expect(sentMessages).toHaveLength(5);
    expect(sentMessages[4]).toContain(JSON.stringify('Zulip y "Event Router"'));
    expect(sentMessages[4]).toContain("No guardes transcripts");
    const handoffCommand = commands.get(HANDOFF_COMMAND);
    expect(handoffCommand?.description).toContain("named adjacent tab");
    await handoffCommand!.handler('continuar "runtime"', {});
    expect(sentMessages).toHaveLength(6);
    expect(sentMessages[5]).toContain(JSON.stringify("OMP Habitat · 2"));
    expect(sentMessages[5]).toContain('placement {kind:"tab"}');
    expect(sentMessages[5]).toContain('persistence:"saved"');
    expect(sentMessages[5]).toContain("Si esta persistencia o sus checks fallan, no abras otra sesión");

    const prior = ["existing"]; const result = await handlers.before_agent_start({ systemPrompt: prior }, { cwd: "C:\\dev\\omp", hasUI: true });
    expect(result.systemPrompt.slice(0, 1)).toEqual(prior); expect(result.systemPrompt).toHaveLength(2); expect(result.systemPrompt.filter((x: string) => x === "existing")).toHaveLength(1);
    const toolResult = await contextTool!.execute("id", {}, new AbortController().signal, () => {}, { cwd: "C:\\dev\\omp", hasUI: true, model: { provider: "openai-codex", id: "gpt-5.6-sol" } });
    const details = toolResult.details as { harness: { agentDir?: string; model?: { provider: string; id: string; thinking?: string } } };
    expect(toolResult.content[0].type).toBe("text"); expect(details.harness.agentDir).toBe(agentDir);
    expect(details.harness.model).toEqual({ provider: "openai-codex", id: "gpt-5.6-sol", thinking: "medium" });

    const invalid = await sessionTool!.execute("id", { cwd: "C:\\tmp", prompt: "x", placement: { type: "split", direction: "right", size: 50 }, fresh: true, persistence: "saved", model: { type: "inherit" }, focus: false }, new AbortController().signal, () => {}, {});
    expect(JSON.parse(invalid.content[0].text).reason).toContain("{kind:'tab'} means adjacent named tab");

    const missingCwd = await sessionTool!.execute("id", { cwd: `${agentDir}/missing`, prompt: "x", pane: { title: "Implementador", onExit: "keep-open" }, fresh: true, persistence: "saved", model: { mode: "inherit" }, focus: false }, new AbortController().signal, () => {}, {});
    expect(JSON.parse(missingCwd.content[0].text).reason).toContain("cwd must already exist as a directory");
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});
test("runtime fragment stays below fixed limit", () => {
  const context = { version: 1 as const, harness: { id: "omp", hasUI: false }, host: { kind: "terminal" as const, provider: "wezterm", trust: "validated-local-probe" as const }, location: { instanceRef: "x", cwd: "x" }, capabilities: {} };
  expect(compactRuntimeFragment(context).length).toBeLessThanOrEqual(MAX_RUNTIME_FRAGMENT_LENGTH);
});
test("increments bounded handoff session generations", () => {
  expect(nextHandoffTitle("os · Handoff", "")).toBe("os · Handoff · 2");
  expect(nextHandoffTitle("os · Handoff · 2", "")).toBe("os · Handoff · 3");
  expect(nextHandoffTitle(undefined, "  Contexto\nnuevo  ")).toBe("Contexto nuevo · 2");
  expect(nextHandoffTitle("x".repeat(600), "").length).toBeLessThanOrEqual(500);
});
