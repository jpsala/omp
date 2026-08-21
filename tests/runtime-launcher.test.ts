import { launchAgent, RuntimeLaunchError, type LaunchDeps, type LaunchRequest } from "../src/runtime-launcher.ts";
import { PROMPT_CHANNEL_HASH_ENV, PROMPT_CHANNEL_URL_ENV } from "../src/runtime-prompt-channel.ts";
import { promptSha256, type HandshakeAck, type MarkerStore } from "../src/runtime-handshake.ts";
const request: LaunchRequest = { cwd: "C:\\work", placement: { kind: "split", direction: "right", percent: 40 }, pane: { title: "Implementador · framing", onExit: "keep-open" }, fresh: true, persistence: "ephemeral", model: { mode: "explicit", spec: "openai/gpt-5" }, prompt: "héllo\nsecond", focus: true };

const ack = (stage: "session_start" | "before_agent_start", extra: Partial<HandshakeAck> = {}): HandshakeAck => ({ version: 1, stage, launchId: "01010101010101010101010101010101", nonce: "nonce", paneId: "child-pane", sessionId: "child-session", sessionName: request.pane.title, model: "openai/gpt-5", timestamp: Date.now(), parentSessionId: "parent", instanceRef: "wez-instance", ...extra });
function harness(acks: HandshakeAck[], opts: { timeoutMs?: number; pollMs?: number; deferSessionStartMs?: number } = {}) {
  const events: string[] = [];
  const channelPrompts: string[] = [];
  const childEnvironments: Array<Record<string, string | undefined> | undefined> = [];
  const clockStartedAt = Date.now();
  let clock = clockStartedAt;
  let cleaned = false;
  let killed = false;
  let channelClosed = false;
  const markers: MarkerStore = { publish: async () => {}, consume: async (_id, stage) => {
    if (stage === "session_start" && clock < clockStartedAt + (opts.deferSessionStartMs ?? 0)) return undefined;
    const i = acks.findIndex(a => a.stage === stage);
    return i < 0 ? undefined : acks.splice(i, 1)[0];
  }, cleanup: async () => { cleaned = true; } };
  const adapter = {
    split: async (value: { env?: Record<string, string | undefined> }) => { events.push("split"); childEnvironments.push(value.env); return { ownedPaneId: "child-pane" }; },
    tab: async (value: { env?: Record<string, string | undefined> }) => { events.push("tab"); childEnvironments.push(value.env); return { ownedPaneId: "child-pane" }; },
    finalizeTab: async (_handle: unknown, title: string) => { events.push(`finalize:${title}`); },
    focus: async () => { events.push("focus"); },
    killOwnedPane: async () => { killed = true; events.push("kill"); },
  };
  const deps: LaunchDeps = {
    adapter,
    markers,
    source: { instanceRef: "wez-instance", paneId: "source-pane" },
    parentSessionId: "parent",
    model: "openai/gpt-5",
    random: () => new Uint8Array(16).fill(1),
    nonce: () => "nonce",
    now: () => clock,
    timeoutMs: opts.timeoutMs ?? 100,
    pollMs: opts.pollMs ?? 20,
    sleep: async ms => { clock += ms; },
    openPromptChannel: async prompt => {
      channelPrompts.push(prompt);
      return {
        environment: {
          [PROMPT_CHANNEL_URL_ENV]: "http://127.0.0.1:1234/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          [PROMPT_CHANNEL_HASH_ENV]: promptSha256(prompt),
        },
        close: async () => { channelClosed = true; },
      };
    },
    buildChild: async (_r, env) => { events.push(`build:${env.sourcePaneId}:${env.instanceRef}`); return { program: "omp", args: ["--child"], env: { EXISTING: "yes" } }; },
  };
  return { deps, events, channelPrompts, childEnvironments, get channelClosed() { return channelClosed; }, get cleaned() { return cleaned; }, get killed() { return killed; } };
}

test("launches through the explicit source and hands off the exact unicode prompt", async () => {
  const h = harness([ack("session_start"), ack("before_agent_start", { promptHash: promptSha256(request.prompt) })]);
  const result = await launchAgent(request, h.deps);
  expect(result.ok).toBe(true);
  expect(h.events).toEqual(["build:source-pane:wez-instance", "split", "focus"]);
  expect(h.channelPrompts).toEqual([request.prompt]);
  expect(h.channelClosed).toBe(true);
  expect(h.cleaned).toBe(true);
});

test("hands a long multiline prompt to the ephemeral channel exactly once", async () => {
  const prompt = "line with unicode á\n".repeat(4_000);
  const longRequest = { ...request, prompt };
  const h = harness([ack("session_start"), ack("before_agent_start", { promptHash: promptSha256(prompt) })]);
  await launchAgent(longRequest, h.deps);
  expect(h.channelPrompts).toEqual([prompt]);
  expect(h.channelClosed).toBe(true);
});

test("merges prompt channel metadata into the child environment", async () => {
  const h = harness([ack("session_start"), ack("before_agent_start", { promptHash: promptSha256(request.prompt) })]);
  await launchAgent(request, h.deps);
  expect(h.childEnvironments[0]?.EXISTING).toBe("yes");
  expect(h.childEnvironments[0]?.[PROMPT_CHANNEL_HASH_ENV]).toBe(promptSha256(request.prompt));
  expect(h.childEnvironments[0]?.[PROMPT_CHANNEL_URL_ENV]).toContain("http://127.0.0.1:");
});
test("reports rejected acknowledgements and rolls back the owned pane", async () => {
  for (const [bad, expected] of [[{ nonce: "wrong" }, "nonce_mismatch"], [{ paneId: "other" }, "pane_mismatch"], [{ sessionId: "parent" }, "session_mismatch"], [{ sessionName: "wrong" }, "session_name_mismatch"]] as const) {
    const h = harness([ack("session_start", bad)]);
    try {
      await launchAgent(request, h.deps);
      throw new Error("expected launch failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeLaunchError);
      expect((error as RuntimeLaunchError).details.rejectedAck).toBe(expected);
    }
    expect(h.killed).toBe(true);
    expect(h.cleaned).toBe(true);
  }
  const h = harness([ack("session_start"), ack("before_agent_start", { model: "other/model" })]);
  await expect(launchAgent(request, h.deps)).rejects.toThrow("last rejected ack: model_mismatch");
  expect(h.killed).toBe(true);
});

test("reports structured timeout diagnostics and cleans marker state", async () => {
  const h = harness([], { timeoutMs: 1 });
  try {
    await launchAgent(request, h.deps);
    throw new Error("expected launch failure");
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeLaunchError);
    expect((error as RuntimeLaunchError).details).toMatchObject({
      status: "failed",
      stage: "session_start",
      paneCreated: true,
      sessionStartAck: false,
      rollback: "completed",
    });
  }
  expect(h.cleaned).toBe(true);
  expect(h.killed).toBe(true);
});

test("fails fast when the child reports a prompt channel failure", async () => {
  const h = harness([
    ack("session_start"),
    ack("before_agent_start", { failureCode: "prompt_channel_failed" }),
  ]);
  await expect(launchAgent(request, h.deps)).rejects.toThrow("before_agent_start failed: prompt_channel_failed");
  expect(h.killed).toBe(true);
});

test("reconciles an acknowledgement that arrives on the timeout boundary without opening another pane", async () => {
  const h = harness(
    [ack("session_start"), ack("before_agent_start", { promptHash: promptSha256(request.prompt) })],
    { timeoutMs: 100, pollMs: 70, deferSessionStartMs: 100 },
  );
  const result = await launchAgent(request, h.deps);
  expect(result.paneId).toBe("child-pane");
  expect(h.events.filter(event => event === "split")).toHaveLength(1);
  expect(h.killed).toBe(false);
});

test("uses adjacent named tab placement and does not replay consumed acknowledgements", async () => {
  const r = { ...request, placement: { kind: "tab" as const } }; const h = harness([ack("session_start"), ack("before_agent_start", { promptHash: promptSha256(request.prompt) })]); const result = await launchAgent(r, h.deps); expect(result.paneId).toBe("child-pane"); expect(h.events).toContain("tab"); expect(h.events).toContain(`finalize:${request.pane.title}`);
});

test("rolls back the owned pane when adjacent tab finalization fails", async () => {
  const r = { ...request, placement: { kind: "tab" as const } };
  const h = harness([]);
  h.deps.adapter.finalizeTab = async () => { throw new Error("tab order mismatch"); };
  try {
    await launchAgent(r, h.deps);
    throw new Error("expected launch failure");
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeLaunchError);
    expect((error as RuntimeLaunchError).details.stage).toBe("finalize_tab");
  }
  expect(h.killed).toBe(true);
});
