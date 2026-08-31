import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { markerRoot, randomLaunchId } from "./runtime-handshake.ts";

export type ChildCompletionStatus = "completed" | "failed" | "cancelled";
export type ChildProgressState = "working" | "waiting" | "blocked";

export interface PendingChildSession {
  version: 1;
  launchId: string;
  parentSessionId: string;
  childSessionId: string;
  childName: string;
  paneId: string;
  startedAt: number;
}

export interface ChildSessionCompletion {
  version: 1;
  launchId: string;
  parentSessionId: string;
  childSessionId: string;
  childName: string;
  paneId: string;
  status: ChildCompletionStatus;
  summary: string;
  completedAt: number;
}
export interface ChildSessionProgress {
  version: 1;
  reportId: string;
  launchId: string;
  parentSessionId: string;
  childSessionId: string;
  childName: string;
  paneId: string;
  state: ChildProgressState;
  detail: string;
  updatedAt: number;
}


export interface CompletionBatch {
  completions: ChildSessionCompletion[];
  progress: ChildSessionProgress[];
  remaining: number;
}

export interface CompletionFs {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeFile(path: string, data: string, options?: { encoding?: BufferEncoding; flag?: string; mode?: number }): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  chmod?: (path: string, mode: number) => Promise<void>;
}

export class CompletionTurnGate {
  #queued = 0;
  #integrationTurn = false;

  queue(): void {
    this.#queued++;
  }

  rollbackQueue(): void {
    if (this.#queued > 0) this.#queued--;
  }

  agentStart(): void {
    if (this.#integrationTurn || this.#queued === 0) return;
    this.#integrationTurn = true;
    this.#queued--;
  }

  endAgentTurn(willContinue = false): boolean {
    const integrationTurn = this.#integrationTurn;
    if (!willContinue) this.#integrationTurn = false;
    return integrationTurn;
  }
}

export interface CompletionStore {
  register(pending: PendingChildSession): Promise<void>;
  publish(completion: ChildSessionCompletion): Promise<void>;
  publishProgress(progress: ChildSessionProgress): Promise<void>;
  acknowledge(completions: readonly ChildSessionCompletion[]): Promise<void>;
  hasActivity(parentSessionId: string): Promise<boolean>;
  hasPending(parentSessionId: string): Promise<boolean>;
  consume(parentSessionId: string): Promise<CompletionBatch>;
}

const nativeFs: CompletionFs = { chmod, mkdir, readdir, readFile, rename, unlink, writeFile };
const ID = /^[A-Za-z0-9._-]{1,160}$/;
const MAX_TITLE = 500;
const MAX_SUMMARY = 16_000;
const MAX_PROGRESS_DETAIL = 2_000;
const COMPLETION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const safeId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const safeTitle = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= MAX_TITLE && !/[\u0000-\u001f\u007f]/.test(value);
const safeTimestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) <= Date.now() + 5 * 60_000 && (value as number) >= Date.now() - COMPLETION_TTL_MS;
const safeStatus = (value: unknown): value is ChildCompletionStatus => value === "completed" || value === "failed" || value === "cancelled";
const safeProgressState = (value: unknown): value is ChildProgressState => value === "working" || value === "waiting" || value === "blocked";

function validPending(value: unknown, parentSessionId?: string): value is PendingChildSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pending = value as PendingChildSession;
  return pending.version === 1
    && safeId(pending.launchId)
    && safeId(pending.parentSessionId)
    && (parentSessionId === undefined || pending.parentSessionId === parentSessionId)
    && safeId(pending.childSessionId)
    && safeTitle(pending.childName)
    && safeId(pending.paneId)
    && safeTimestamp(pending.startedAt);
}

function validCompletion(value: unknown, parentSessionId?: string): value is ChildSessionCompletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const completion = value as ChildSessionCompletion;
  return completion.version === 1
    && safeId(completion.launchId)
    && safeId(completion.parentSessionId)
    && (parentSessionId === undefined || completion.parentSessionId === parentSessionId)
    && safeId(completion.childSessionId)
    && safeTitle(completion.childName)
    && safeId(completion.paneId)
    && safeStatus(completion.status)
    && typeof completion.summary === "string"
    && !!completion.summary.trim()
    && completion.summary.length <= MAX_SUMMARY
    && safeTimestamp(completion.completedAt);
}
function validProgress(value: unknown, parentSessionId?: string): value is ChildSessionProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const progress = value as ChildSessionProgress;
  return progress.version === 1
    && safeId(progress.reportId)
    && safeId(progress.launchId)
    && safeId(progress.parentSessionId)
    && (parentSessionId === undefined || progress.parentSessionId === parentSessionId)
    && safeId(progress.childSessionId)
    && safeTitle(progress.childName)
    && safeId(progress.paneId)
    && safeProgressState(progress.state)
    && typeof progress.detail === "string"
    && !!progress.detail.trim()
    && progress.detail.length <= MAX_PROGRESS_DETAIL
    && !/[\u0000-\u001f\u007f]/.test(progress.detail)
    && safeTimestamp(progress.updatedAt);
}


export function summarizeAgentCompletion(messages: readonly AgentMessage[]): { status: ChildCompletionStatus; summary: string } {
  const assistant = messages.findLast((message): message is AssistantMessage => message.role === "assistant");
  const text = assistant?.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map(block => block.text)
    .join("\n")
    .trim();
  const status: ChildCompletionStatus = assistant?.stopReason === "error"
    ? "failed"
    : assistant?.stopReason === "aborted"
      ? "cancelled"
      : "completed";
  const fallback = assistant?.errorMessage?.trim() || `Child session ${status} without final assistant text.`;
  return { status, summary: (text || fallback).slice(0, MAX_SUMMARY) };
}

export const COMPLETION_FOLLOW_UP_PREFIX = "El runtime recibió resultados de ";


export function shouldReportCompletionUpstream(input: {
  launchedChildren: boolean;
  hasPendingChildren: boolean;
  willContinue: boolean;
  completionFollowUp: boolean;
}): boolean {
  if (input.willContinue || input.hasPendingChildren) return false;
  return !input.launchedChildren || input.completionFollowUp;
}

export function renderCompletionFollowUp(batch: CompletionBatch): string {
  const reports = batch.completions.map(completion => JSON.stringify({
    name: completion.childName,
    sessionId: completion.childSessionId,
    paneId: completion.paneId,
    status: completion.status,
    summary: completion.summary.slice(0, 4_000),
  }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e"));
  return `${COMPLETION_FOLLOW_UP_PREFIX}${batch.completions.length} sesión(es) hija(s):\n${reports.join("\n")}\n\nQuedan ${batch.remaining} sesión(es) hija(s) pendientes. Integrá estos resultados ahora, verificá directamente cualquier cambio o afirmación antes de aceptarla y continuá la orquestación sin esperar que el usuario te avise.`;
}
export function isCompletionFollowUpTurn(messages: readonly AgentMessage[]): boolean {
  const userMessage = messages.findLast(message => message.role === "user");
  if (!userMessage) return false;
  const content = userMessage.content;
  const text = typeof content === "string"
    ? content
    : content
        .filter((block): block is Extract<(typeof content)[number], { type: "text" }> => block.type === "text")
        .map(block => block.text)
        .join("\n");
  return text.startsWith(COMPLETION_FOLLOW_UP_PREFIX);
}

export function completionRoot(base = markerRoot()): string {
  return join(base, "completions");
}

export function createCompletionStore(root: string, fs: CompletionFs = nativeFs): CompletionStore {
  const parentDirectory = (parentSessionId: string) => {
    if (!safeId(parentSessionId)) throw new Error("invalid parent session id");
    return join(root, parentSessionId);
  };
  const pendingPath = (pending: Pick<PendingChildSession, "parentSessionId" | "launchId">) => join(parentDirectory(pending.parentSessionId), `${pending.launchId}.pending.json`);
  const completionPath = (completion: Pick<ChildSessionCompletion, "parentSessionId" | "launchId">) => join(parentDirectory(completion.parentSessionId), `${completion.launchId}.completion.json`);
  const progressPath = (progress: Pick<ChildSessionProgress, "parentSessionId" | "launchId" | "reportId">) => join(parentDirectory(progress.parentSessionId), `${progress.launchId}.${progress.reportId}.progress.json`);
  const secure = async (path: string, mode: number) => { if (fs.chmod) await fs.chmod(path, mode); };
  const atomicWrite = async (path: string, value: unknown) => {
    const directory = dirname(path);
    await fs.mkdir(directory, { recursive: true });
    await secure(directory, 0o700);
    const temporary = `${path}.${randomLaunchId().slice(0, 16)}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await secure(temporary, 0o600);
    await fs.rename(temporary, path);
  };
  const unlinkIfPresent = async (path: string) => {
    try {
      await fs.unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  const names = async (parentSessionId: string) => {
    try { return await fs.readdir(parentDirectory(parentSessionId)); }
    catch { return []; }
  };

  return {
    async register(pending) {
      if (!validPending(pending)) throw new Error("invalid pending child session");
      await atomicWrite(pendingPath(pending), pending);
    },
    async publish(completion) {
      if (!validCompletion(completion)) throw new Error("invalid child completion");
      await atomicWrite(completionPath(completion), completion);
    },
    async publishProgress(progress) {
      if (!validProgress(progress)) throw new Error("invalid child progress");
      await atomicWrite(progressPath(progress), progress);
    },
    async hasActivity(parentSessionId) {
      return (await names(parentSessionId)).some(name => name.endsWith(".pending.json") || name.endsWith(".completion.json") || name.endsWith(".progress.json"));
    },
    async hasPending(parentSessionId) {
      return (await names(parentSessionId)).some(name => name.endsWith(".pending.json"));
    },
    async acknowledge(completions) {
      for (const completion of completions) {
        if (!validCompletion(completion)) throw new Error("invalid child completion");
        await unlinkIfPresent(pendingPath(completion));
        await unlinkIfPresent(completionPath(completion));
      }
    },
    async consume(parentSessionId) {
      if (!safeId(parentSessionId)) return { completions: [], progress: [], remaining: 0 };
      const directory = parentDirectory(parentSessionId);
      const progress: ChildSessionProgress[] = [];
      for (const name of (await names(parentSessionId)).filter(value => value.endsWith(".progress.json")).sort()) {
        const source = join(directory, name);
        const claimed = `${source}.${randomLaunchId().slice(0, 16)}.claimed`;
        try {
          await fs.rename(source, claimed);
          try {
            const value = JSON.parse(await fs.readFile(claimed, "utf8"));
            if (validProgress(value, parentSessionId)) progress.push(value);
          } finally {
            await fs.unlink(claimed).catch(() => {});
          }
        } catch {}
      }
      const completions: ChildSessionCompletion[] = [];
      for (const name of (await names(parentSessionId)).filter(value => value.endsWith(".completion.json")).sort()) {
        const source = join(directory, name);
        try {
          const value = JSON.parse(await fs.readFile(source, "utf8"));
          if (validCompletion(value, parentSessionId)) completions.push(value);
          else await fs.unlink(source).catch(() => {});
        } catch {}
      }
      const pendingCount = (await names(parentSessionId)).filter(name => name.endsWith(".pending.json")).length;
      const deliveredLaunches = new Set(completions.map(completion => completion.launchId));
      const remaining = Math.max(0, pendingCount - deliveredLaunches.size);
      return { completions, progress, remaining };
    },
  };
}
