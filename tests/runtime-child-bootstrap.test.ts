import { expect, test } from "bun:test";
import {
  buildChildEnvironment,
  buildInteractiveEnvironment,
  createBootstrapArgv,
  interactiveShellCommand,
  paneTitleSequence,
  parseBootstrapArgs,
  runBootstrap,
  type BootstrapSpawner,
} from "../scripts/runtime-child-bootstrap.ts";
import { HANDOFF_AFTER_TAB_ENV, RUNTIME_SESSION_TITLE_ENV, handoffTabPlacementSequence } from "../src/runtime-tab-placement.ts";

const metadata = {
  launchId: "launch-1",
  nonce: "nonce-1",
  parentSessionId: "parent-1",
  title: "Implementador · framing",
  onExit: "keep-open" as const,
  agentDir: "C:/Users/test/.omp/agent",
};

test("round trips metadata separately from the target command", () => {
  const argv = createBootstrapArgv(metadata, "omp", ["--cwd", "C:/dev/omp", "--model", "openai-codex/gpt-5.6-sol"]);
  expect(parseBootstrapArgs(argv)).toEqual({
    metadata,
    program: "omp",
    args: ["--cwd", "C:/dev/omp", "--model", "openai-codex/gpt-5.6-sol"],
  });
  expect(argv.join(" ")).not.toContain("prompt text");
});

test("sets runtime markers from the actual child pane and scrubs recursion markers", () => {
  const environment = buildChildEnvironment(metadata, {
    PATH: "x",
    WEZTERM_PANE: "91",
    WEZTERM_UNIX_SOCKET: "socket-1",
    AGENT: "1",
    OMPCODE: "1",
    CLAUDECODE: "1",
    CI: "1",
    PI_CODING_AGENT_SESSION_DIR: "old",
  });
  expect(environment).toMatchObject({
    PATH: "x",
    WEZTERM_PANE: "91",
    WEZTERM_UNIX_SOCKET: "socket-1",
    OMP_RUNTIME_LAUNCH_ID: "launch-1",
    OMP_RUNTIME_NONCE: "nonce-1",
    OMP_RUNTIME_PARENT_SESSION: "parent-1",
    OMP_RUNTIME_PANE_ID: "91",
    OMP_RUNTIME_INSTANCE: "socket-1",
    PI_CODING_AGENT_DIR: "C:/Users/test/.omp/agent",
    [RUNTIME_SESSION_TITLE_ENV]: metadata.title,
  });
  for (const name of ["AGENT", "OMPCODE", "CLAUDECODE", "CI", "PI_CODING_AGENT_SESSION_DIR"]) {
    expect(environment[name]).toBeUndefined();
  }
});

test("keeps the pane open in a clean interactive shell after OMP exits", async () => {
  const calls: Array<{ program: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const exitCodes = [7, 0];
  const spawnProcess: BootstrapSpawner = (program, args, options) => {
    const listeners: Partial<Record<"error" | "exit", Function>> = {};
    const processHandle = {
      once(event: "error" | "exit", listener: Function) {
        listeners[event] = listener;
        return processHandle;
      },
    };
    calls.push({ program, args, env: options.env });
    queueMicrotask(() => listeners.exit?.(exitCodes.shift() ?? 0));
    return processHandle;
  };
  const titles: string[] = [];
  const base = {
    WEZTERM_PANE: "91",
    WEZTERM_UNIX_SOCKET: "socket-1",
    OMP_RUNTIME_PROMPT_URL: "http://127.0.0.1/token",
    OMP_RUNTIME_PROMPT_SHA256: "hash",
    AGENT: "1",
    KEEP: "yes",
    [HANDOFF_AFTER_TAB_ENV]: "8",
  };
  const code = await runBootstrap(
    { metadata, program: "omp", args: ["--cwd", "C:/dev/omp"] },
    base,
    spawnProcess,
    title => titles.push(title),
  );
  expect(code).toBe(0);
  expect(calls.map(call => call.program)).toEqual(["omp", "pwsh.exe"]);
  expect(calls[1].args).toEqual(["-NoLogo"]);
  expect(calls[0].env.OMP_RUNTIME_LAUNCH_ID).toBe("launch-1");
  expect(calls[0].env[RUNTIME_SESSION_TITLE_ENV]).toBe(metadata.title);
  expect(calls[0].env[HANDOFF_AFTER_TAB_ENV]).toBeUndefined();
  expect(calls[1].env.OMP_RUNTIME_LAUNCH_ID).toBeUndefined();
  expect(calls[1].env.OMP_RUNTIME_PROMPT_URL).toBeUndefined();
  expect(calls[1].env.AGENT).toBeUndefined();
  expect(calls[1].env.KEEP).toBe("yes");
  expect(titles).toEqual([paneTitleSequence(metadata.title)+handoffTabPlacementSequence("8")]);
});

test("provides platform shells and strips runtime state from interactive environments", () => {
  expect(interactiveShellCommand("win32", {})).toEqual({ program: "pwsh.exe", args: ["-NoLogo"] });
  expect(interactiveShellCommand("linux", { SHELL: "/bin/zsh" })).toEqual({ program: "/bin/zsh", args: ["-l"] });
  expect(buildInteractiveEnvironment({ OMP_RUNTIME_NONCE: "x", CI: "1", KEEP: "yes" })).toEqual({ KEEP: "yes" });
  expect(() => paneTitleSequence("bad\u0007title")).toThrow();
  expect(() => handoffTabPlacementSequence("bad")).toThrow();
});

test("rejects malformed metadata and missing host identity", () => {
  expect(() => parseBootstrapArgs(["--launch-id", "x", "--", "omp"])).toThrow();
  expect(() => parseBootstrapArgs(["--launch-id", "x", "--launch-id", "y", "--", "omp"])).toThrow();
  expect(() => buildChildEnvironment(metadata, { WEZTERM_PANE: "bad", WEZTERM_UNIX_SOCKET: "x" })).toThrow();
  expect(() => buildChildEnvironment(metadata, { WEZTERM_PANE: "1" })).toThrow();
});
