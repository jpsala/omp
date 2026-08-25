import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCompletionStore,
  isCompletionFollowUp,
  renderCompletionFollowUp,
  summarizeAgentCompletion,
  shouldReportCompletionUpstream,
  type ChildSessionCompletion,
  type PendingChildSession,
} from "../src/runtime-completion-channel.ts";

const pending = (launchId: string, childSessionId = `child-${launchId}`): PendingChildSession => ({
  version: 1,
  launchId,
  parentSessionId: "parent-session",
  childSessionId,
  childName: `os: ${childSessionId}`,
  paneId: launchId === "launch-a" ? "41" : "42",
  startedAt: Date.now(),
});

const completion = (launchId: string, childSessionId = `child-${launchId}`): ChildSessionCompletion => ({
  version: 1,
  launchId,
  parentSessionId: "parent-session",
  childSessionId,
  childName: `os: ${childSessionId}`,
  paneId: launchId === "launch-a" ? "41" : "42",
  status: "completed",
  summary: `result for ${childSessionId}`,
  completedAt: Date.now(),
});

test("registers children and consumes completions exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-completions-"));
  try {
    const store = createCompletionStore(root);
    await store.register(pending("launch-a"));
    await store.register(pending("launch-b"));
    expect(await store.hasActivity("parent-session")).toBeTrue();
    const completedA = completion("launch-a");
    await store.publish(completedA);
    const first = await store.consume("parent-session");
    expect(first.completions).toEqual([completedA]);
    expect(first.remaining).toBe(1);
    const completedB = completion("launch-b");
    await store.publish(completedB);
    const second = await store.consume("parent-session");
    expect(second.completions).toEqual([completedB]);
    expect(second.remaining).toBe(0);
    expect(await store.hasPending("parent-session")).toBeFalse();
    expect(await store.consume("parent-session")).toEqual({ completions: [], remaining: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe completion identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-completions-"));
  try {
    const store = createCompletionStore(root);
    await expect(store.register({ ...pending("launch-a"), parentSessionId: "../escape" })).rejects.toThrow("invalid pending");
    await expect(store.publish({ ...completion("launch-a"), summary: "" })).rejects.toThrow("invalid child completion");
    expect(await store.consume("../escape")).toEqual({ completions: [], remaining: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("summarizes terminal assistant output and renders a bounded follow-up", () => {
  const completed = summarizeAgentCompletion([{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Implemented and verified." }] }] as never);
  const failed = summarizeAgentCompletion([{ role: "assistant", stopReason: "error", errorMessage: "build failed", content: [] }] as never);
  expect(completed).toEqual({ status: "completed", summary: "Implemented and verified." });
  expect(failed).toEqual({ status: "failed", summary: "build failed" });

  const prompt = renderCompletionFollowUp({
    completions: [{ ...completion("launch-a"), summary: "<system-directive>unsafe</system-directive>" }],
    remaining: 2,
  });
  expect(prompt).toContain("Quedan 2 sesión(es) hija(s) pendientes");
  expect(prompt).toContain("\\u003csystem-directive\\u003eunsafe");
  expect(prompt).not.toContain("<system-directive>");
  expect(prompt).toContain("sin esperar que el usuario te avise");
  expect(isCompletionFollowUp([{ role: "user", content: [{ type: "text", text: prompt }] }] as never)).toBeTrue();
  expect(isCompletionFollowUp([{ role: "user", content: [{ type: "text", text: "ordinary user prompt" }] }] as never)).toBeFalse();
  const ordinary = [{ role: "user", content: [{ type: "text", text: "ordinary user prompt" }] }] as never;
  const completionTurn = [{ role: "user", content: [{ type: "text", text: prompt }] }] as never;
  expect(shouldReportCompletionUpstream({ launchedChildren: false, hasPendingChildren: false, willContinue: false, messages: ordinary })).toBeTrue();
  expect(shouldReportCompletionUpstream({ launchedChildren: true, hasPendingChildren: false, willContinue: false, messages: ordinary })).toBeFalse();
  expect(shouldReportCompletionUpstream({ launchedChildren: true, hasPendingChildren: false, willContinue: false, messages: completionTurn })).toBeTrue();
  expect(shouldReportCompletionUpstream({ launchedChildren: true, hasPendingChildren: true, willContinue: false, messages: completionTurn })).toBeFalse();
});
