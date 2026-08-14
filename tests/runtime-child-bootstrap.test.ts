import { expect, test } from "bun:test";
import {
  buildChildEnvironment,
  createBootstrapArgv,
  parseBootstrapArgs,
} from "../scripts/runtime-child-bootstrap.ts";

const metadata = {
  launchId: "launch-1",
  nonce: "nonce-1",
  parentSessionId: "parent-1",
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
  });
  for (const name of ["AGENT", "OMPCODE", "CLAUDECODE", "CI", "PI_CODING_AGENT_SESSION_DIR"]) {
    expect(environment[name]).toBeUndefined();
  }
});

test("rejects malformed metadata and missing host identity", () => {
  expect(() => parseBootstrapArgs(["--launch-id", "x", "--", "omp"])).toThrow();
  expect(() => parseBootstrapArgs(["--launch-id", "x", "--launch-id", "y", "--", "omp"])).toThrow();
  expect(() => buildChildEnvironment(metadata, { WEZTERM_PANE: "bad", WEZTERM_UNIX_SOCKET: "x" })).toThrow();
  expect(() => buildChildEnvironment(metadata, { WEZTERM_PANE: "1" })).toThrow();
});
