import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, rename, readFile, unlink, readdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export type AckStage = "session_start" | "before_agent_start";
export type HandshakeFailureCode = "prompt_channel_failed" | "session_name_failed";
export interface HandshakeAck {
  version: 1; stage: AckStage; launchId: string; nonce: string; paneId: string;
  sessionId: string; sessionName?: string; model: string; timestamp: number; promptHash?: string;
  failureCode?: HandshakeFailureCode;
  parentSessionId?: string; instanceRef?: string;
}
export interface MarkerStore {
  publish(ack: HandshakeAck): Promise<void>;
  consume(launchId: string, stage: AckStage): Promise<HandshakeAck | undefined>;
  cleanup(launchId: string): Promise<void>;
}
export interface MarkerFs {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeFile(path: string, data: string, options?: { encoding?: BufferEncoding; flag?: string; mode?: number }): Promise<void>;
  rename(a: string, b: string): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  chmod?: (path: string, mode: number) => Promise<void>;
}
const nativeFs: MarkerFs = { mkdir, writeFile, rename, readFile, unlink, readdir, chmod };
const safe = (x: string) => typeof x === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(x);
const stages: AckStage[] = ["session_start", "before_agent_start"];
const TTL_MS = 60_000;
export const MARKER_TTL_MS = TTL_MS;
export function promptSha256(prompt: string): string { return createHash("sha256").update(prompt, "utf8").digest("hex"); }
export function randomLaunchId(random: () => Uint8Array = () => randomBytes(16)): string {
  const bytes = random(); if (bytes.length < 16) throw new Error("random source too short");
  return Buffer.from(bytes).toString("hex");
}
export function markerRoot(user = process.env.USERNAME || process.env.USER || "unknown", base = tmpdir()): string {
  return join(base, `omp-agent-runtime-${user.replace(/[^A-Za-z0-9._-]/g, "_")}`);
}
function validAck(value: unknown, stage: AckStage): value is HandshakeAck {
  if (!value || typeof value !== "object") return false;
  const a = value as HandshakeAck;
  return a.version === 1 && a.stage === stage && safe(a.launchId) && safe(a.nonce) &&
    safe(a.paneId) && safe(a.sessionId) && typeof a.model === "string" && /^[A-Za-z0-9._:/-]{1,200}$/.test(a.model) &&
    Number.isSafeInteger(a.timestamp) && Math.abs(Date.now() - a.timestamp) <= TTL_MS &&
    (a.promptHash === undefined || /^[a-f0-9]{64}$/.test(a.promptHash)) &&
    (a.sessionName === undefined || (typeof a.sessionName === "string" && !!a.sessionName.trim() && a.sessionName.length <= 500 && !/[\u0000-\u001f\u007f]/.test(a.sessionName))) &&
    (a.failureCode === undefined || a.failureCode === "prompt_channel_failed" || a.failureCode === "session_name_failed");
}
export function createMarkerStore(root: string, fs: MarkerFs = nativeFs): MarkerStore {
  const pathFor = (id: string, stage: AckStage) => join(root, `${id}.${stage}.json`);
  const secure = async (path: string, mode: number) => { if (fs.chmod) await fs.chmod(path, mode); };
  return {
    async publish(ack) {
      if (!validAck(ack, ack.stage) || !stages.includes(ack.stage)) throw new Error("invalid ack");
      await fs.mkdir(root, { recursive: true }); await secure(root, 0o700);
      const final = pathFor(ack.launchId, ack.stage);
      const temp = `${final}.${randomLaunchId().slice(0, 16)}.tmp`;
      await fs.writeFile(temp, JSON.stringify(ack), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await secure(temp, 0o600); await fs.rename(temp, final);
    },
    async consume(id, stage) {
      if (!safe(id) || !stages.includes(stage)) return undefined;
      const source = pathFor(id, stage), claimed = `${source}.${randomLaunchId().slice(0, 16)}.consumed`;
      try {
        await fs.rename(source, claimed);
        try { const value = JSON.parse(await fs.readFile(claimed, "utf8")); return validAck(value, stage) ? value : undefined; }
        finally { await fs.unlink(claimed).catch(() => {}); }
      } catch { return undefined; }
    },
    async cleanup(id) {
      if (!safe(id)) return;
      let names: string[]; try { names = await fs.readdir(root); } catch { return; }
      await Promise.all(names.filter(n => n.startsWith(`${id}.`)).map(n => fs.unlink(join(root, n)).catch(() => {})));
    }
  };
}
