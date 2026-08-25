import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { markerRoot, randomLaunchId } from "./runtime-handshake.ts";

export type ChildCompletionStatus = "completed" | "failed" | "cancelled";

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

export interface CompletionBatch {
  completions: ChildSessionCompletion[];
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

export interface CompletionStore {
  register(pending: PendingChildSession): Promise<void>;
  publish(completion: ChildSessionCompletion): Promise<void>;
  hasActivity(parentSessionId: string): Promise<boolean>;
  hasPending(parentSessionId: string): Promise<boolean>;
  consume(parentSessionId: string): Promise<CompletionBatch>;
}

const nativeFs: CompletionFs = { chmod, mkdir, readdir, readFile, rename, unlink, writeFile };
const ID = /^[A-Za-z0-9._-]{1,160}$/;
const MAX_TITLE = 500;
const MAX_SUMMARY = 16_000;
const COMPLETION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const safeId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const safeTitle = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= MAX_TITLE && !/[\u0000-\u001f\u007f]/.test(value);
const safeTimestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) <= Date.now() + 5 * 60_000 && (value as number) >= Date.now() - COMPLETION_TTL_MS;
const safeStatus = (value: unknown): value is ChildCompletionStatus => value === "completed" || value === "failed" || value === "cancelled";

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

export function isCompletionFollowUp(messages: readonly AgentMessage[]): boolean {
  const user = messages.findLast(message => message.role === "user") as { content?: unknown } | undefined;
  const content = user?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .filter(block => block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string")
        .map(block => block.text)
        .join("\n")
      : "";
  return text.startsWith(COMPLETION_FOLLOW_UP_PREFIX);
}

export function shouldReportCompletionUpstream(input: {
  launchedChildren: boolean;
  hasPendingChildren: boolean;
  willContinue: boolean;
  messages: readonly AgentMessage[];
}): boolean {
  if (input.willContinue || input.hasPendingChildren) return false;
  return !input.launchedChildren || isCompletionFollowUp(input.messages);
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
  const secure = async (path: string, mode: number) => { if (fs.chmod) await fs.chmod(path, mode); };
  const atomicWrite = async (path: string, value: unknown) => {
    const directory = dirname(path);
    await fs.mkdir(directory, { recursive: true });
    await secure(directory, 0o700);
    const temporary = `${path}.${randomLaunchId().slice(0, 16)}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await secure(temporary, 0o600);
    await fs.rename(temporary, path);
    await secure(path, 0o600);
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
    async hasActivity(parentSessionId) {
      return (await names(parentSessionId)).some(name => name.endsWith(".pending.json") || name.endsWith(".completion.json"));
    },
    async hasPending(parentSessionId) {
      return (await names(parentSessionId)).some(name => name.endsWith(".pending.json"));
    },
    async consume(parentSessionId) {
      if (!safeId(parentSessionId)) return { completions: [], remaining: 0 };
      const directory = parentDirectory(parentSessionId);
      const completions: ChildSessionCompletion[] = [];
      for (const name of (await names(parentSessionId)).filter(value => value.endsWith(".completion.json")).sort()) {
        const source = join(directory, name);
        const claimed = `${source}.${randomLaunchId().slice(0, 16)}.claimed`;
        try {
          await fs.rename(source, claimed);
          try {
            const value = JSON.parse(await fs.readFile(claimed, "utf8"));
            if (validCompletion(value, parentSessionId)) {
              completions.push(value);
              await fs.unlink(pendingPath(value)).catch(() => {});
            }
          } finally {
            await fs.unlink(claimed).catch(() => {});
          }
        } catch {}
      }
      const remaining = (await names(parentSessionId)).filter(name => name.endsWith(".pending.json")).length;
      return { completions, remaining };
    },
  };
}
