import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaHostAdapter } from "../src/runtime-host-orca.ts";
import type { RuntimeProcessResult, RuntimeProcessRunner } from "../src/runtime-host.ts";
import { runOrcaCommandBootstrap } from "../scripts/runtime-orca-command-bootstrap.ts";

type Call = { executable: string; argv: string[] };
const envelope = (result: unknown): RuntimeProcessResult => ({ exitCode: 0, stdout: JSON.stringify({ result }), stderr: "" });

function runner(calls: Call[]): RuntimeProcessRunner {
  return async (executable, argv) => {
    calls.push({ executable, argv: [...argv] });
    if (argv[1] === "list") return envelope({ terminals: [{ handle: "term-source", tabId: "tab-source", leafId: "leaf-source", worktreeId: "worktree-1", worktreePath: "C:/dev/omp" }] });
    if (argv[1] === "split") return envelope({ split: { handle: "term-child", tabId: "tab-child", leafId: "leaf-child" } });
    if (argv[1] === "create") return envelope({ terminal: { handle: "term-child", tabId: "tab-child", leafId: "leaf-child", worktreeId: "worktree-1", worktreePath: "C:/dev/omp" } });
    return envelope({});
  };
}

test("uses Orca-native split and maps dedicated windows to tabs without exposing launch environment", async () => {
  const launchDir = await mkdtemp(join(tmpdir(), "omp-orca-adapter-"));
  try {
    const calls: Call[] = [];
    const adapter = new OrcaHostAdapter({ runner: runner(calls), executable: "orca-test", launchDir, bootstrapScript: "C:/dev/omp/scripts/runtime-orca-command-bootstrap.ts" });
    const source = { instanceRef: "worktree-1", paneId: "tab-source:leaf-source" };
    const split = await adapter.split({ source, cwd: "C:/dev/omp", direction: "right", percent: 50, program: "omp", args: ["--model", "x"], env: { OMP_RUNTIME_PROMPT_URL: "secret-url" } });
    const splitCall = calls.find(call => call.argv[1] === "split")!;
    expect(splitCall.argv).toContain("horizontal");
    expect(splitCall.argv.join(" ")).not.toContain("secret-url");
    const command = splitCall.argv[splitCall.argv.indexOf("--command") + 1];
    expect(command).toContain("runtime-orca-command-bootstrap.ts");
    const specName = (await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: launchDir })))[0];
    const specPath = join(launchDir, specName);
    expect(JSON.parse(await readFile(specPath, "utf8"))).toMatchObject({ cwd: "C:/dev/omp", program: "omp", args: ["--model", "x"], env: { OMP_RUNTIME_PROMPT_URL: "secret-url" } });
    expect(split.ownedPaneId).toBe("tab-child:leaf-child");
    await adapter.killOwnedPane(split);
    expect(await Bun.file(specPath).exists()).toBeFalse();
    expect(calls.at(-1)?.argv.slice(0, 4)).toEqual(["terminal", "close", "--terminal", "term-child"]);

    const tab = await adapter.window({ source, cwd: "C:/dev/omp", program: "omp" });
    expect(calls.findLast(call => call.argv[1] === "create")?.argv).toContain("id:worktree-1");
    await adapter.finalizeTab(tab, "Orquestador");
    await adapter.focus(tab);
    expect(calls.some(call => call.argv[1] === "rename" && call.argv.includes("Orquestador"))).toBeTrue();
    expect(calls.some(call => call.argv[1] === "switch" && call.argv.includes("term-child"))).toBeTrue();
    await adapter.killOwnedPane(tab);
  } finally {
    await rm(launchDir, { recursive: true, force: true });
  }
});

test("rejects unsupported Orca split geometry before creating a terminal", async () => {
  const calls: Call[] = [];
  const adapter = new OrcaHostAdapter({ runner: runner(calls) });
  await expect(adapter.split({ source: { instanceRef: "worktree-1", paneId: "tab-source:leaf-source" }, cwd: "x", direction: "left", percent: 50, program: "p" })).rejects.toThrow("50% to the right or bottom");
  expect(calls.some(call => call.argv[1] === "split")).toBeFalse();
});

test("bootstrap consumes its one-time spec and forwards cwd and environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-orca-bootstrap-"));
  try {
    const specPath = join(root, "launch.json");
    const output = join(root, "observed.json");
    await writeFile(specPath, JSON.stringify({ version: 1, cwd: root, program: process.execPath, args: ["-e", `await Bun.write(${JSON.stringify(output)}, JSON.stringify({cwd:process.cwd(), token:process.env.RUNTIME_TEST_TOKEN}))`], env: { RUNTIME_TEST_TOKEN: "forwarded" } }));
    expect(await runOrcaCommandBootstrap(specPath)).toBe(0);
    expect(await Bun.file(specPath).exists()).toBeFalse();
    expect(await Bun.file(output).json()).toEqual({ cwd: root, token: "forwarded" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
