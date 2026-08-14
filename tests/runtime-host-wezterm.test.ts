import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { WezTermHostAdapter, type ProcessResult, type ProcessRunner } from "../src/runtime-host-wezterm.ts";

type Call = { executable: string; argv: string[]; options?: { stdin?: string | Uint8Array; timeoutMs?: number; env?: NodeJS.ProcessEnv } };

function fakeRunner(calls: Call[], result?: ProcessResult): ProcessRunner {
  let createdPanePendingDescribe = false;
  return async (executable, argv, options) => {
    calls.push({ executable, argv: [...argv], options });
    if (argv.includes("split-pane") || argv.includes("spawn")) {
      createdPanePendingDescribe = true;
      return { exitCode: 0, stdout: " 9\r\n", stderr: "" };
    }
    if (argv.includes("send-text") || argv.includes("activate-pane") || argv.includes("kill-pane")) {
      return result ?? { exitCode: 0, stdout: "", stderr: "" };
    }
    if (!argv.includes("list")) throw new Error(`fake runner sequencing exhausted: unexpected argv ${argv.join(" ")}`);
    const rows = createdPanePendingDescribe
      ? [{ pane_id: "7", window_id: 1, tab_id: 2, workspace: "main" }, { pane_id: "9", window_id: 1, tab_id: 2, workspace: "main" }]
      : [{ pane_id: "7", window_id: 1, tab_id: 2, workspace: "main" }];
    createdPanePendingDescribe = false;
    return { exitCode: 0, stdout: JSON.stringify(rows), stderr: "" };
  };
}

function expectSocket(call: Call, instanceRef: string) {
  expect(call.argv).not.toContain("--socket-name");
  expect(call.options?.env?.WEZTERM_UNIX_SOCKET).toBe(instanceRef);
}

test("split and tab use distinct commands and executable argv", async () => {
  const calls: Call[] = [];
  const adapter = new WezTermHostAdapter({ executable: "wezterm.exe", runner: fakeRunner(calls) });
  expect(calls).toHaveLength(0);
  await adapter.split({ source: { instanceRef: "inst", paneId: "7" }, cwd: "C:\\dev\\omp", direction: "right", percent: 40, program: "omp", args: ["--flag"] });
  await adapter.tab({ source: { instanceRef: "inst", paneId: "7" }, cwd: "C:\\dev\\omp", program: "omp", args: ["--flag"] });
  const split = calls.find(call => call.argv.includes("split-pane")!);
  const tab = calls.find(call => call.argv.includes("spawn")!);
  expect(split?.argv.slice(-3)).toEqual(["--", "omp", "--flag"]);
  expect(split?.argv).not.toContain("--socket-name");
  expect(tab?.argv).toContain("spawn");
  for (const call of calls) expectSocket(call, "inst");
  expect(calls[0].argv).toContain("split-pane");
});

test("retries until a newly created pane becomes visible in the mux list", async () => {
  const calls: Call[] = [];
  let listCount = 0;
  const runner: ProcessRunner = async (executable, argv, options) => {
    calls.push({ executable, argv: [...argv], options });
    if (argv.includes("split-pane")) return { exitCode: 0, stdout: "9\n", stderr: "" };
    if (argv.includes("list")) {
      listCount++;
      const rows = [{ pane_id: 7, window_id: 1, tab_id: 2 }];
      if (listCount > 1) rows.push({ pane_id: 9, window_id: 1, tab_id: 2 });
      return { exitCode: 0, stdout: JSON.stringify(rows), stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const adapter = new WezTermHostAdapter({ runner });
  const handle = await adapter.split({
    source: { instanceRef: "inst", paneId: "7" },
    cwd: "C:/dev/omp",
    direction: "right",
    percent: 50,
    program: "omp",
  });
  expect(handle.location.paneId).toBe("9");
  expect(listCount).toBe(2);
  expect(calls.some(call => call.argv.includes("kill-pane"))).toBe(false);
});


test("successful create registers ownership and kill consumes it", async () => {
  const calls: Call[] = [];
  const adapter = new WezTermHostAdapter({ runner: fakeRunner(calls) });
  const handle = await adapter.split({ source: { instanceRef: "inst", paneId: "7" }, cwd: "x", direction: "right", percent: 40, program: "p" });
  await adapter.killOwnedPane(handle);
  expect(calls.at(-1)?.argv).toEqual(["cli", "kill-pane", "--pane-id", "9"]);
  await expect(adapter.killOwnedPane(handle)).rejects.toThrow("unowned");
});

test("kill treats an already exited owned pane as successful cleanup", async () => {
  const calls: Call[] = [];
  const adapter = new WezTermHostAdapter({ runner: fakeRunner(calls, { exitCode: 1, stdout: "", stderr: "Error: no such pane 9" }) });
  const handle = await adapter.split({ source: { instanceRef: "inst", paneId: "7" }, cwd: "x", direction: "right", percent: 40, program: "p" });
  await expect(adapter.killOwnedPane(handle)).resolves.toBeUndefined();
  await expect(adapter.killOwnedPane(handle)).rejects.toThrow("unowned");
});

test("rejects forged, wrong-source, and unowned handles", async () => {
  const calls: Call[] = [];
  const adapter = new WezTermHostAdapter({ runner: fakeRunner(calls) });
  const owned = await adapter.split({ source: { instanceRef: "inst", paneId: "7" }, cwd: "x", direction: "right", percent: 40, program: "p" });
  for (const forged of [
    { ...owned },
    { ...owned, sourcePaneId: "8" },
    { ...owned, instanceRef: "other" },
    { ...owned, ownedPaneId: "7" },
  ]) await expect(adapter.focus(forged)).rejects.toThrow("unowned");
});

test("post-create incomplete/list failure rolls back exact owned pane once", async () => {
  const calls: Call[] = [];
  let phase = 0;
  const runner: ProcessRunner = async (executable, argv, options) => {
    calls.push({ executable, argv: [...argv], options });
    if (argv.includes("list")) return phase++ === 0 ? { exitCode: 0, stdout: JSON.stringify([{ pane_id: 7, window_id: 1, tab_id: 2 }]), stderr: "" } : { exitCode: 3, stdout: "", stderr: "list boom" };
    if (argv.includes("split-pane")) return { exitCode: 0, stdout: "42\r\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const adapter = new WezTermHostAdapter({ runner });
  await expect(adapter.split({ source: { instanceRef: "i", paneId: "7" }, cwd: "x", direction: "right", percent: 40, program: "p" })).rejects.toThrow();
  const kills = calls.filter(c => c.argv.includes("kill-pane"));
  expect(kills).toHaveLength(1);
  expect(kills[0].argv).toEqual(["cli", "kill-pane", "--pane-id", "42"]);
});

test("post-create rollback accepts a pane that already exited", async () => {
  let listCount = 0;
  const runner: ProcessRunner = async (_executable, argv) => {
    if (argv.includes("list")) {
      listCount++;
      return listCount === 1
        ? { exitCode: 0, stdout: JSON.stringify([{ pane_id: 7, window_id: 1, tab_id: 2 }]), stderr: "" }
        : { exitCode: 3, stdout: "", stderr: "list boom" };
    }
    if (argv.includes("split-pane")) return { exitCode: 0, stdout: "42\n", stderr: "" };
    if (argv.includes("kill-pane")) return { exitCode: 1, stdout: "", stderr: "Error: no such pane 42" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const adapter = new WezTermHostAdapter({ runner });
  const error = await adapter.split({ source: { instanceRef: "i", paneId: "7" }, cwd: "x", direction: "right", percent: 40, program: "p" }).catch(value => value);
  expect(error).not.toBeInstanceOf(AggregateError);
  expect(error.message).toContain("list failed");
});

test("describe rejects malformed, incomplete, absent panes and returns location", async () => {
  for (const stdout of ["not-json", "{}", "[]", JSON.stringify([{ pane_id: 8, window_id: 1, tab_id: 2 }])]) {
    const adapter = new WezTermHostAdapter({ runner: async () => ({ exitCode: 0, stdout, stderr: "" }) });
    await expect(adapter.describe({ instanceRef: "i", paneId: "7" })).rejects.toThrow();
  }
  const adapter = new WezTermHostAdapter({ runner: async () => ({ exitCode: 0, stdout: JSON.stringify([{ pane_id: 7, window_id: 4, tab_id: 5, cwd: "C:/x" }]), stderr: "" }) });
  await expect(adapter.describe({ instanceRef: "i", paneId: "7" })).resolves.toMatchObject({ windowId: "4", tabId: "5", cwd: "C:/x" });
});

test("supports file URI cwd, timeout, CRLF, and invalid pane IDs", async () => {
  const calls: Call[] = [];
  const adapter = new WezTermHostAdapter({ runner: fakeRunner(calls), executable: "fake", timeoutMs: 88 });
  const h = await adapter.split({ source: { instanceRef: "i", paneId: "7" }, cwd: "file:///C:/a%20b", direction: "left", percent: 25, program: "p", args: ["x\r\n", "a\tb"] });
  await adapter.focus(h);
  const split = calls.find(c => c.argv.includes("split-pane"))!;
  expect(split.argv).toEqual(["cli", "split-pane", "--pane-id", "7", "--left", "--percent", "25", "--cwd", fileURLToPath(new URL("file:///C:/a%20b")), "--", "p", "x\r\n", "a\tb"]);
  expect(calls.at(-1)?.argv).toEqual(["cli", "activate-pane", "--pane-id", "9"]);
  for (const call of calls) { expectSocket(call, "i"); expect(call.options?.timeoutMs).toBe(88); }
  const bad = new WezTermHostAdapter({ runner: async (_e, argv) => argv.includes("list") ? { exitCode: 0, stdout: JSON.stringify([{ pane_id: 7, window_id: 1, tab_id: 2 }]), stderr: "" } : { exitCode: 0, stdout: "12x", stderr: "" } });
  await expect(bad.split({ source: { instanceRef: "i", paneId: "7" }, cwd: "x", direction: "top", percent: 1, program: "p" })).rejects.toThrow("invalid pane id");
});
 
test("uses native fileURLToPath for UNC cwd", async () => {
  const calls: Call[] = [];
  const adapter = new WezTermHostAdapter({ runner: fakeRunner(calls) });
  await adapter.split({ source: { instanceRef: "i", paneId: "7" }, cwd: "file://server/share/a%20b", direction: "right", percent: 40, program: "p" });
  const split = calls.find(c => c.argv.includes("split-pane"))!;
  expect(split.argv).toContain("--cwd");
  expect(split.argv[split.argv.indexOf("--cwd") + 1]).toBe(process.platform === "win32" ? "\\\\server\\share\\a b" : "//server/share/a b");
});

test("surfaces primary and rollback failures while removing ownership", async () => {
  const calls: Call[] = [];
  let listCount = 0;
  const runner: ProcessRunner = async (executable, argv, options) => {
    calls.push({ executable, argv: [...argv], options });
    if (argv.includes("list")) {
      listCount++;
      if (listCount === 1) return { exitCode: 0, stdout: JSON.stringify([{ pane_id: 7, window_id: 1, tab_id: 2 }]), stderr: "" };
      return { exitCode: 4, stdout: "", stderr: "describe failed" };
    }
    if (argv.includes("split-pane")) return { exitCode: 0, stdout: "42\n", stderr: "" };
    if (argv.includes("kill-pane")) return { exitCode: 5, stdout: "", stderr: "rollback failed" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const adapter = new WezTermHostAdapter({ runner });
  const error = await adapter.split({ source: { instanceRef: "i", paneId: "7" }, cwd: "x", direction: "right", percent: 40, program: "p" }).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toHaveLength(2);
  expect(error.errors[0].message).toContain("list failed");
  expect(error.errors[1].message).toContain("kill-pane failed");
  const handle = { instanceRef: "i", sourcePaneId: "7", ownedPaneId: "42", location: {} };
  await expect(adapter.focus(handle)).rejects.toThrow("unowned");
  expect(calls.filter(c => c.argv.includes("kill-pane"))).toHaveLength(1);
});
