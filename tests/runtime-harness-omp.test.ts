import { describe, expect, test } from "bun:test";
import { OMP_FRESH_OVERLAY_PATH, OMP_RECURSION_MARKERS, translateOmpRequest } from "../src/runtime-harness-omp.ts";

const context = (extra: Record<string, unknown> = {}) => ({ version: 1 as const, harness: { id: "omp" as const, hasUI: false, agentDir: "C:/agent", model: { provider: "fallback", id: "wrong" } }, host: { kind: "headless" as const, provider: "unknown", trust: "unknown" as const }, capabilities: {}, ...extra });
const request = (persistence: "saved" | "ephemeral" = "saved", model: { mode: "inherit" } | { mode: "explicit"; spec: string } = { mode: "inherit" }) => ({ version: 1 as const, cwd: "C:/dev/omp", placement: { kind: "tab" as const }, pane: { title: "Implementador", onExit: "close" as const }, fresh: true, persistence, model, prompt: "never argv", focus: false });

describe("OMP Phase 3 translation", () => {
  test("saved fresh uses overlay and resolved inherited model", async () => {
    const result = await translateOmpRequest(request(), { ...context(), models: { current: () => ({ provider: "openai", id: "gpt" }) } }, { AGENT: "x", OMPCODE: "x", CLAUDECODE: "x", CI: "1", KEEP: "yes" });
    expect(result).toMatchObject({ executable: "omp", cwd: "C:/dev/omp", argv: ["--cwd", "C:/dev/omp", "--model", "openai/gpt", "--config", OMP_FRESH_OVERLAY_PATH] });
    if ("env" in result) expect(result.env).toEqual({ KEEP: "yes", PI_CODING_AGENT_DIR: "C:/agent" });
  });
  test("accepts installed full current model and projects only provider/id", async () => {
    const result = await translateOmpRequest(request(), {
      ...context(),
      models: {
        current: () => ({
          provider: "openai",
          id: "gpt-5",
          name: "GPT-5",
          contextWindow: 400000,
          inputCost: 1.25,
          outputCost: 10,
          reasoning: true,
        }),
      },
    }, { KEEP: "yes" });
    expect(result).toMatchObject({
      argv: ["--cwd", "C:/dev/omp", "--model", "openai/gpt-5", "--config", OMP_FRESH_OVERLAY_PATH],
      env: { KEEP: "yes", PI_CODING_AGENT_DIR: "C:/agent" },
    });
    if ("argv" in result) expect(result.argv).not.toContain("GPT-5");
  });
  test("ephemeral fresh alone gets --no-session", async () => {
    const result = await translateOmpRequest(request("ephemeral", { mode: "explicit", spec: "anthropic/sonnet" }), context(), {});
    expect(result).toMatchObject({ argv: ["--cwd", "C:/dev/omp", "--model", "anthropic/sonnet", "--no-session"] });
  });
  test("accepts dedicated window placement without changing child argv", async () => {
    const result = await translateOmpRequest({ ...request(), placement: { kind: "window" as const } }, context());
    expect(result).toMatchObject({ argv: ["--cwd", "C:/dev/omp", "--model", "fallback/wrong", "--config", OMP_FRESH_OVERLAY_PATH] });
  });
  test("incompatible non-fresh request is structured", async () => {
    const result = await translateOmpRequest({ ...request(), fresh: false }, context());
    expect(result).toEqual({ kind: "unsupported", code: "incompatible-request", message: "Only fresh sessions are supported" });
  });
  test("passes effective profile without guessing a default", async () => {
    const result = await translateOmpRequest(request(), { ...context(), effectiveProfile: "team-profile" });
    expect(result).toMatchObject({ argv: ["--cwd", "C:/dev/omp", "--model", "fallback/wrong", "--config", OMP_FRESH_OVERLAY_PATH, "--profile", "team-profile"] });
  });
  test("appends exact closed workflow flags without changing legacy argv order", async () => {
    const legacy = await translateOmpRequest(request(), context());
    expect(legacy).toMatchObject({ argv: ["--cwd", "C:/dev/omp", "--model", "fallback/wrong", "--config", OMP_FRESH_OVERLAY_PATH] });

    const prewalk = await translateOmpRequest({ ...request(), workflow: { mode: "prewalk" as const, target: "@smol" } }, context());
    expect(prewalk).toMatchObject({ argv: ["--cwd", "C:/dev/omp", "--model", "fallback/wrong", "--config", OMP_FRESH_OVERLAY_PATH, "--prewalk", "--prewalk-into", "@smol"] });

    const planYolo = await translateOmpRequest({ ...request(), workflow: { mode: "plan-yolo" as const, target: "@smol", advisor: true } }, context());
    expect(planYolo).toMatchObject({ argv: ["--cwd", "C:/dev/omp", "--model", "fallback/wrong", "--config", OMP_FRESH_OVERLAY_PATH, "--plan-yolo", "--plan-yolo-into", "@smol", "--advisor"] });
  });

  test("supports workflow mode alone and emits advisor only when opted in", async () => {
    const result = await translateOmpRequest({ ...request("ephemeral"), workflow: { mode: "prewalk" as const, advisor: false } }, context());
    expect(result).toMatchObject({ argv: ["--cwd", "C:/dev/omp", "--model", "fallback/wrong", "--no-session", "--prewalk"] });
  });

  test("scrubs exact recursion and inherited session markers while preserving unrelated env", async () => {
    const result = await translateOmpRequest(request(), context(), {
      AGENT: "x", OMPCODE: "x", CLAUDECODE: "x", CI: "1", PI_CODING_AGENT_SESSION_DIR: "inherited",
      PI_CODING_AGENT_DIR: "old", KEEP: "yes",
    });
    if ("env" in result) expect(result.env).toEqual({ KEEP: "yes", PI_CODING_AGENT_DIR: "C:/agent" });
    expect(OMP_RECURSION_MARKERS).toContain("PI_CODING_AGENT_SESSION_DIR");
  });

  test("uses fallback harness model when current resolves undefined", async () => {
    const result = await translateOmpRequest(request(), { ...context(), models: { current: async () => undefined as never } });
    expect(result).toMatchObject({ argv: ["--cwd", "C:/dev/omp", "--model", "fallback/wrong", "--config", OMP_FRESH_OVERLAY_PATH] });
  });

  test("rejects malformed runtime inputs strictly", async () => {
    const cases = [
      [{ ...request(), version: 2 }, context()],
      [{ ...request(), cwd: 42 }, context()],
      [{ ...request(), model: { mode: "bogus" } }, context()],
      [{ ...request(), persistence: "mystery" }, context()],
      [request(), { ...context(), version: 2 }],
    ];
    for (const [badRequest, badContext] of cases) {
      await expect(translateOmpRequest(badRequest as never, badContext as never)).resolves.toMatchObject({ kind: "unsupported", code: "incompatible-request" });
    }
  });
  test("rejects non-closed or malformed workflows before translation", async () => {
    for (const workflow of [
      { mode: "prewalk", extra: true },
      { mode: "plan-yolo", target: "   " },
      { mode: "plan-yolo", advisor: "yes" },
      { mode: "other" },
    ]) {
      const result = await translateOmpRequest({ ...request(), workflow } as never, context());
      expect(result).toMatchObject({ kind: "unsupported", code: "incompatible-request" });
      expect(result).not.toHaveProperty("argv");
    }
  });
  test("omits agent-dir override when no effective agentDir exists", async () => {
    const { agentDir: _ignored, ...harness } = context().harness;
    const result = await translateOmpRequest(request("ephemeral"), { ...context(), harness }, {});
    if ("env" in result) expect(result.env).toEqual({});
  });
  test("rejects malformed canonical fields and context extensions without translation", async () => {
    const cases = [
      { ...context(), harness: { ...context().harness, model: { provider: "", id: "bad" } } },
      { ...context(), host: { ...context().host, provider: "" } },
      { ...context(), unexpected: true },
      { ...context(), models: { current: "not a function" } },
      { ...context(), effectiveProfile: "   " },
    ];
    for (const badContext of cases) {
      const result = await translateOmpRequest(request(), badContext as never);
      expect(result).toMatchObject({ kind: "unsupported", code: "incompatible-request" });
      expect(result).not.toHaveProperty("argv");
    }
  });

  test("converts current-model throws and rejections to unsupported", async () => {
    for (const current of [
      () => { throw new Error("boom"); },
      async () => { throw new Error("boom"); },
    ]) {
      const result = await translateOmpRequest(request(), { ...context(), models: { current } });
      expect(result).toMatchObject({ kind: "unsupported", code: "incompatible-request" });
      expect(result).not.toHaveProperty("argv");
    }
  });
});
