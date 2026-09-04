import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
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

interface OrcaTerminal {
  handle: string;
  tabId: string;
  paneKey: string;
  worktreeId: string;
  title?: string;
  worktreePath?: string;
}

interface OrcaPaneHandle extends RuntimePaneHandle { terminalHandle: string; launchSpecPath: string }
export interface OrcaAdapterOptions { runner?: RuntimeProcessRunner; executable?: string; timeoutMs?: number; launchDir?: string; bootstrapScript?: string }

const defaultRunner: RuntimeProcessRunner = (executable, argv, options = {}) => {
  const { promise, resolve, reject } = Promise.withResolvers<RuntimeProcessResult>();
  const child = spawn(executable, [...argv], { shell: false, windowsHide: true, env: options.env, stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  const out: Buffer[] = [], err: Buffer[] = []; let timer: NodeJS.Timeout | undefined;
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  child.stdout.on("data", value => out.push(Buffer.from(value)));
  child.stderr.on("data", value => err.push(Buffer.from(value)));
  if (options.timeoutMs) timer = setTimeout(() => { child.kill(); reject(new Error(`process timeout after ${options.timeoutMs}ms`)); }, options.timeoutMs);
  child.once("error", reject);
  child.once("close", code => { clearTimeout(timer); resolve({ exitCode: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }); });
  return promise;
};


function fail(name: string, result: RuntimeProcessResult): never { throw new Error(`${name} failed: ${(result.stderr || result.stdout || `exit ${result.exitCode}`).trim()}`); }
function paneKey(value: Record<string, unknown>): string | undefined {
  if (typeof value.paneKey === "string" && value.paneKey) return value.paneKey;
  return typeof value.tabId === "string" && typeof value.leafId === "string" ? `${value.tabId}:${value.leafId}` : undefined;
}
function terminal(value: unknown, fallbackWorktreeId?: string): OrcaTerminal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Orca returned an invalid terminal");
  const item = value as Record<string, unknown>;
  const key = paneKey(item);
  const worktreeId = typeof item.worktreeId === "string" && item.worktreeId ? item.worktreeId : fallbackWorktreeId;
  if (typeof item.handle !== "string" || !item.handle || typeof item.tabId !== "string" || !item.tabId || !key || !worktreeId) throw new Error("Orca returned an incomplete terminal");
  return { handle: item.handle, tabId: item.tabId, paneKey: key, worktreeId, ...(typeof item.title === "string" ? { title: item.title } : {}), ...(typeof item.worktreePath === "string" ? { worktreePath: item.worktreePath } : {}) };
}
function payload(stdout: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error("Orca returned invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("result" in parsed)) throw new Error("Orca returned an incomplete response");
  const result = parsed.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Orca returned an incomplete response");
  return result as Record<string, unknown>;
}
function quote(value: string): string { return process.platform === "win32" ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, `'\\''`)}'`; }
function alreadyGone(result: RuntimeProcessResult): boolean { return result.exitCode !== 0 && /terminal_handle_stale|terminal.*not found|no terminal/i.test(result.stderr || result.stdout); }

export class OrcaHostAdapter implements RuntimeHostAdapter {
  private readonly run: RuntimeProcessRunner;
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly launchDir: string;
  private readonly bootstrapScript: string;
  private readonly owned = new Map<string, OrcaPaneHandle>();

  constructor(options: OrcaAdapterOptions = {}) {
    this.run = options.runner ?? defaultRunner;
    this.executable = options.executable ?? (process.platform === "win32" ? "orca.exe" : "orca");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.launchDir = options.launchDir ?? join(tmpdir(), "omp-orca-runtime-launches");
    this.bootstrapScript = options.bootstrapScript ?? fileURLToPath(new URL("../scripts/runtime-orca-command-bootstrap.ts", import.meta.url));
  }

  private options(extra: RuntimeProcessRunOptions = {}): RuntimeProcessRunOptions { return { ...extra, timeoutMs: this.timeoutMs, env: { ...process.env, ...(extra.env ?? {}) } }; }
  private async call(name: string, argv: readonly string[]): Promise<Record<string, unknown>> {
    const result = await this.run(this.executable, [...argv, "--json"], this.options());
    if (result.exitCode !== 0) fail(name, result);
    return payload(result.stdout);
  }
  private key(handle: Pick<RuntimePaneHandle, "instanceRef" | "sourcePaneId" | "ownedPaneId">): string { return `${handle.instanceRef}\0${handle.sourcePaneId}\0${handle.ownedPaneId}`; }
  private assertOwned(handle: RuntimePaneHandle): OrcaPaneHandle {
    const owned = this.owned.get(this.key(handle));
    if (!owned || owned !== handle || handle.ownedPaneId === handle.sourcePaneId) throw new Error("refusing to use unowned pane");
    return owned;
  }
  private location(value: OrcaTerminal): RuntimeHostLocation { return { instanceRef: value.worktreeId, windowId: value.worktreeId, tabId: value.tabId, paneId: value.paneKey, workspace: value.worktreeId, ...(value.worktreePath ? { cwd: value.worktreePath } : {}) }; }
  private async list(source: RuntimeHostSource): Promise<OrcaTerminal[]> {
    const result = await this.call("Orca terminal list", ["terminal", "list", "--worktree", `id:${source.instanceRef}`]);
    if (!Array.isArray(result.terminals)) throw new Error("Orca terminal list returned incomplete JSON");
    return result.terminals.map(terminal);
  }
  private async sourceTerminal(source: RuntimeHostSource): Promise<OrcaTerminal> {
    const found = (await this.list(source)).find(value => value.paneKey === source.paneId);
    if (!found) throw new Error(`pane ${source.paneId} is not present in Orca worktree`);
    return found;
  }
  private async stage(request: RuntimeTabRequest): Promise<{ path: string; command: string }> {
    await mkdir(this.launchDir, { recursive: true });
    const path = join(this.launchDir, `${randomUUID()}.json`);
    const env = Object.fromEntries(Object.entries(request.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    await writeFile(path, JSON.stringify({ version: 1, cwd: request.cwd, program: request.program, args: [...(request.args ?? [])], env }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { path, command: `bun ${quote(this.bootstrapScript)} ${quote(path)}` };
  }
  private async create(kind: "split" | "tab" | "window", request: RuntimeSplitRequest | RuntimeTabRequest | RuntimeWindowRequest): Promise<RuntimePaneHandle> {
    const source = await this.sourceTerminal(request.source);
    if (kind === "split") {
      const split = request as RuntimeSplitRequest;
      if (split.percent !== 50 || (split.direction !== "right" && split.direction !== "bottom")) throw new Error("Orca supports Habitat splits only at 50% to the right or bottom");
    }
    const staged = await this.stage(request);
    let created: OrcaTerminal | undefined;
    try {
      const result = kind === "split"
        ? await this.call("Orca terminal split", ["terminal", "split", "--terminal", source.handle, "--direction", (request as RuntimeSplitRequest).direction === "right" ? "horizontal" : "vertical", "--command", staged.command])
        : await this.call("Orca terminal create", ["terminal", "create", "--worktree", `id:${request.source.instanceRef}`, "--command", staged.command]);
      created = terminal(kind === "split" ? result.split : result.terminal, request.source.instanceRef);
      if (created.worktreeId !== request.source.instanceRef || created.paneKey === request.source.paneId) throw new Error("Orca created a terminal outside the requested worktree");
      const handle: OrcaPaneHandle = { instanceRef: created.worktreeId, sourcePaneId: request.source.paneId, ownedPaneId: created.paneKey, location: this.location(created), terminalHandle: created.handle, launchSpecPath: staged.path };
      this.owned.set(this.key(handle), handle);
      return handle;
    } catch (error) {
      await rm(staged.path, { force: true }).catch(() => {});
      if (created) {
        const rollback = await this.run(this.executable, ["terminal", "close", "--terminal", created.handle, "--json"], this.options()).catch(value => value as Error);
        if (rollback instanceof Error || ("exitCode" in rollback && rollback.exitCode !== 0 && !alreadyGone(rollback))) throw new AggregateError([error, rollback], "created Orca terminal validation and rollback both failed");
      }
      throw error;
    }
  }

  split(request: RuntimeSplitRequest) { return this.create("split", request); }
  tab(request: RuntimeTabRequest) { return this.create("tab", request); }
  window(request: RuntimeWindowRequest) { return this.create("window", request); }
  async finalizeTab(handle: RuntimePaneHandle, title: string): Promise<void> {
    const owned = this.assertOwned(handle);
    if (!title.trim() || title.length > 500 || /[\u0000-\u001f\u007f]/.test(title)) throw new Error("invalid tab title");
    await this.call("Orca terminal rename", ["terminal", "rename", "--terminal", owned.terminalHandle, "--title", title]);
  }
  async focus(handle: RuntimePaneHandle): Promise<void> { const owned = this.assertOwned(handle); await this.call("Orca terminal switch", ["terminal", "switch", "--terminal", owned.terminalHandle]); }
  async isOwnedPanePresent(handle: RuntimePaneHandle): Promise<boolean> {
    const owned = this.assertOwned(handle);
    return (await this.list({ instanceRef: owned.instanceRef, paneId: owned.sourcePaneId })).some(value => value.paneKey === owned.ownedPaneId && value.handle === owned.terminalHandle);
  }
  async killOwnedPane(handle: RuntimePaneHandle): Promise<void> {
    const owned = this.assertOwned(handle);
    const result = await this.run(this.executable, ["terminal", "close", "--terminal", owned.terminalHandle, "--json"], this.options());
    await rm(owned.launchSpecPath, { force: true });
    if (result.exitCode !== 0 && !alreadyGone(result)) fail("Orca terminal close", result);
    this.owned.delete(this.key(owned));
  }
}

export const createOrcaAdapter = (options?: OrcaAdapterOptions) => new OrcaHostAdapter(options);
