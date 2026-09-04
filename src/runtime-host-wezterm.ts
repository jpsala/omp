import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HANDOFF_AFTER_TAB_ENV } from "./runtime-tab-placement.ts";
import type {
  RuntimeHostAdapter,
  RuntimeHostLocation,
  RuntimeHostSource,
  RuntimePaneHandle,
  RuntimeProcessResult,
  RuntimeProcessRunner,
  RuntimeProcessRunOptions,
  RuntimeSplitRequest,
  RuntimeTabRequest,
  RuntimeWindowRequest,
} from "./runtime-host.ts";

export type ProcessResult = RuntimeProcessResult;
export type ProcessRunOptions = RuntimeProcessRunOptions;
export type ProcessRunner = RuntimeProcessRunner;
export type WezTermLocation = RuntimeHostLocation;
export type WezTermSource = RuntimeHostSource;
export type WezTermPaneHandle = RuntimePaneHandle;
export type SplitRequest = RuntimeSplitRequest;
export type TabRequest = RuntimeTabRequest;
export type WindowRequest = RuntimeWindowRequest;
export interface WezTermAdapterOptions { runner?: ProcessRunner; executable?: string; timeoutMs?: number }

const defaultRunner: ProcessRunner = (executable, argv, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(executable, [...argv], { shell: false, windowsHide: true, env: options.env, stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  const out: Buffer[] = [], err: Buffer[] = []; let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  child.stdout.on("data", x => out.push(Buffer.from(x))); child.stderr.on("data", x => err.push(Buffer.from(x)));
  if (options.timeoutMs) timer = setTimeout(() => { child.kill(); reject(new Error(`process timeout after ${options.timeoutMs}ms`)); }, options.timeoutMs);
  child.once("error", reject); child.once("close", code => { if (timer) clearTimeout(timer); resolve({ exitCode: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }); });
});
function normalizedCwd(cwd: string): string { if (!cwd.startsWith("file://")) { if (/^[a-z][a-z0-9+.-]*:\/\//i.test(cwd)) throw new Error(`unsupported cwd URL: ${cwd}`); return cwd; } return fileURLToPath(new URL(cwd)); }
function id(stdout: string): string { const value = stdout.trim(); if (!/^\d+$/.test(value)) throw new Error(`invalid pane id: ${JSON.stringify(value)}`); return String(Number(value)); }
function fail(name: string, result: ProcessResult): never { throw new Error(`${name} failed: ${(result.stderr || result.stdout || `exit ${result.exitCode}`).trim()}`); }
function paneAlreadyGone(result: ProcessResult): boolean {
  const detail = result.stderr || result.stdout;
  return result.exitCode !== 0 && /\bno such pane(?:\s+\d+)?\b/i.test(detail);
}
export class WezTermHostAdapter implements RuntimeHostAdapter {
  private readonly run: ProcessRunner; private readonly executable: string; private readonly timeoutMs: number; private readonly owned = new Map<string, WezTermPaneHandle>();
  constructor(options: WezTermAdapterOptions = {}) { this.run = options.runner ?? defaultRunner; this.executable = options.executable ?? (process.platform === "win32" ? "wezterm.exe" : "wezterm"); this.timeoutMs = options.timeoutMs ?? 5000; }
  private opts(instanceRef: string, extra: ProcessRunOptions = {}): ProcessRunOptions { return { ...extra, timeoutMs: this.timeoutMs, env: { ...process.env, ...(extra.env ?? {}), WEZTERM_UNIX_SOCKET: instanceRef } }; }
  private async listRows(instanceRef: string): Promise<unknown[]> {
    const result = await this.run(this.executable, ["cli", "list", "--format", "json"], this.opts(instanceRef));
    if (result.exitCode !== 0) fail("wezterm list", result);
    let rows: unknown;
    try {
      rows = JSON.parse(result.stdout);
    } catch {
      throw new Error("wezterm list returned invalid JSON");
    }
    if (!Array.isArray(rows)) throw new Error("wezterm list returned incomplete JSON");
    return rows;
  }
  async describe(source: WezTermSource): Promise<WezTermLocation> {
    const candidates = await this.listRows(source.instanceRef);
    const row = candidates.find(candidate =>
      candidate !== null
      && typeof candidate === "object"
      && !Array.isArray(candidate)
      && "pane_id" in candidate
      && String(candidate.pane_id) === source.paneId
    );
    if (
      row === null
      || typeof row !== "object"
      || Array.isArray(row)
      || !("pane_id" in row)
      || !("window_id" in row)
      || !("tab_id" in row)
      || row.window_id === undefined
      || row.tab_id === undefined
    ) {
      throw new Error(`pane ${source.paneId} is not present in WezTerm instance`);
    }
    return {
      instanceRef: source.instanceRef,
      windowId: String(row.window_id),
      tabId: String(row.tab_id),
      paneId: String(row.pane_id),
      ...(!("workspace" in row) || row.workspace === undefined ? {} : { workspace: String(row.workspace) }),
      ...(!("cwd" in row) || row.cwd === undefined ? {} : { cwd: normalizedCwd(String(row.cwd)) }),
    };
  }
  private key(h: Pick<WezTermPaneHandle, "instanceRef" | "sourcePaneId" | "ownedPaneId">) { return `${h.instanceRef}\0${h.sourcePaneId}\0${h.ownedPaneId}`; }
  private assertOwned(h: WezTermPaneHandle) { if (!h.instanceRef || !h.sourcePaneId || !h.ownedPaneId || h.ownedPaneId === h.sourcePaneId || this.owned.get(this.key(h)) !== h) throw new Error("refusing to use unowned pane"); }
  private async rollbackCreatedPane(instanceRef: string, paneId: string): Promise<void> {
    const result = await this.run(
      this.executable,
      ["cli", "kill-pane", "--pane-id", paneId],
      this.opts(instanceRef),
    );
    if (result.exitCode !== 0 && !paneAlreadyGone(result)) fail("wezterm kill-pane", result);
  }
  private async describeCreatedPane(source: WezTermSource): Promise<WezTermLocation> {
    let absent: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        return await this.describe(source);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("is not present in WezTerm instance")) throw error;
        absent = error;
        if (attempt < 9) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 25);
          await promise;
        }
      }
    }
    throw new Error(`created pane ${source.paneId} did not become observable in WezTerm instance`, { cause: absent });
  }


  private async open(input: { kind: "split"; request: SplitRequest } | { kind: "tab"; request: TabRequest } | { kind: "window"; request: WindowRequest }) {
    const { kind, request } = input;
    const cwd = normalizedCwd(request.cwd);
    const argv = kind === "split"
      ? ["cli", "split-pane", "--pane-id", request.source.paneId, `--${request.direction}`, "--percent", String(request.percent), "--cwd", cwd, "--", request.program, ...(request.args ?? [])]
      : kind === "window"
        ? ["cli", "spawn", "--pane-id", request.source.paneId, "--new-window", "--cwd", cwd, "--", request.program, ...(request.args ?? [])]
        : ["cli", "spawn", "--pane-id", request.source.paneId, "--cwd", cwd, "--", request.program, ...(request.args ?? [])];
    const result = await this.run(
      this.executable,
      argv,
      this.opts(request.source.instanceRef, { env: request.env }),
    );
    if (result.exitCode !== 0) fail(`wezterm ${kind}`, result);

    const ownedPaneId = id(result.stdout);
    try {
      const handle = {
        instanceRef: request.source.instanceRef,
        sourcePaneId: request.source.paneId,
        ownedPaneId,
        location: await this.describeCreatedPane({
          instanceRef: request.source.instanceRef,
          paneId: ownedPaneId,
        }),
      };
      this.owned.set(this.key(handle), handle);
      return handle;
    } catch (primaryError) {
      try {
        await this.rollbackCreatedPane(request.source.instanceRef, ownedPaneId);
      } catch (rollbackError) {
        throw new AggregateError(
          [primaryError, rollbackError],
          "created pane validation and rollback both failed",
        );
      }
      throw primaryError;
    }
  }
  split(request: SplitRequest) { return this.open({ kind: "split", request }); }
  async tab(request: TabRequest) {
    const source = await this.describe(request.source);
    return this.open({
      kind: "tab",
      request: {
        ...request,
        env: { ...request.env, [HANDOFF_AFTER_TAB_ENV]: source.tabId },
      },
    });
  }
  window(request: WindowRequest) { return this.open({ kind: "window", request }); }
  async finalizeTab(h: WezTermPaneHandle, title: string, requireAdjacentToSource = true): Promise<void> {
    this.assertOwned(h);
    if (!title.trim() || title.length > 500 || /[\u0000-\u001f\u007f]/.test(title)) throw new Error("invalid tab title");
    const renamed = await this.run(
      this.executable,
      ["cli", "set-tab-title", "--tab-id", h.location.tabId, title],
      this.opts(h.instanceRef),
    );
    if (renamed.exitCode !== 0) fail("wezterm set-tab-title", renamed);
    if (!requireAdjacentToSource) return;
    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = await this.listRows(h.instanceRef);
      const source = rows.find(row => row !== null && typeof row === "object" && !Array.isArray(row) && "pane_id" in row && String(row.pane_id) === h.sourcePaneId);
      const owned = rows.find(row => row !== null && typeof row === "object" && !Array.isArray(row) && "pane_id" in row && String(row.pane_id) === h.ownedPaneId);
      if (source && owned && "window_id" in source && "window_id" in owned && String(source.window_id) === String(owned.window_id) && "tab_id" in source && "tab_id" in owned) {
        const order: string[] = [];
        for (const row of rows) {
          if (row === null || typeof row !== "object" || Array.isArray(row) || !("window_id" in row) || !("tab_id" in row) || String(row.window_id) !== String(source.window_id)) continue;
          const tabId = String(row.tab_id);
          if (!order.includes(tabId)) order.push(tabId);
        }
        const sourceIndex = order.indexOf(String(source.tab_id));
        if (sourceIndex >= 0 && order[sourceIndex + 1] === String(owned.tab_id)) return;
      }
      if (attempt < 39) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 25);
        await promise;
      }
    }
    throw new Error("created tab did not move immediately after its source tab");
  }
  async focus(h: WezTermPaneHandle) { this.assertOwned(h); const r = await this.run(this.executable, ["cli", "activate-pane", "--pane-id", h.ownedPaneId], this.opts(h.instanceRef)); if (r.exitCode) fail("wezterm activate-pane", r); }
  async isOwnedPanePresent(h: WezTermPaneHandle): Promise<boolean> {
    this.assertOwned(h);
    try {
      const current = await this.describe({ instanceRef: h.instanceRef, paneId: h.ownedPaneId });
      return current.windowId === h.location.windowId && current.tabId === h.location.tabId;
    } catch (error) {
      if (error instanceof Error && error.message.includes("is not present in WezTerm instance")) return false;
      throw error;
    }
  }
  async killOwnedPane(h: WezTermPaneHandle) { this.assertOwned(h); const r = await this.run(this.executable, ["cli", "kill-pane", "--pane-id", h.ownedPaneId], this.opts(h.instanceRef)); if (r.exitCode && !paneAlreadyGone(r)) fail("wezterm kill-pane", r); this.owned.delete(this.key(h)); }
}
export const createWezTermAdapter = (options?: WezTermAdapterOptions) => new WezTermHostAdapter(options);
