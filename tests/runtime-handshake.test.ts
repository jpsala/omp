import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarkerStore, MARKER_TTL_MS, markerRoot, promptSha256, randomLaunchId, type HandshakeAck } from "../src/runtime-handshake.ts";

const ack = (extra: Partial<HandshakeAck> = {}): HandshakeAck => ({ version: 1, stage: "session_start", launchId: "a".repeat(32), nonce: "nonce", paneId: "pane", sessionId: "session", model: "openai-codex/gpt-5.6-sol", timestamp: Date.now(), ...extra });

test("prompt hashing and launch ids are deterministic and safe", () => {
  expect(promptSha256("héllo\nsecond")).toBe("1986a5abd7a7ddd7174dd8832648932af8acb3d65474cfde59fd479b2727b25f");
  expect(randomLaunchId(() => new Uint8Array(16).fill(0xab))).toBe("ab".repeat(16));
  expect(() => randomLaunchId(() => new Uint8Array(2))).toThrow();
});

test("marker root sanitizes user names", () => expect(markerRoot("a/b\\c", "C:\\tmp")).toBe(join("C:\\tmp", "omp-agent-runtime-a_b_c")));

test("publishes atomically with restrictive modes and consumes once", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-marker-"));
  try { const store = createMarkerStore(root); const value = ack(); await store.publish(value); const names = await readdir(root); expect(names).toEqual([`${value.launchId}.session_start.json`]); expect(await store.consume(value.launchId, "session_start")).toEqual(value); expect(await store.consume(value.launchId, "session_start")).toBeUndefined(); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test("publish tolerates a consumer claiming the final marker immediately after rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-marker-race-"));
  const claimed = join(root, "claimed.json");
  try {
    const store = createMarkerStore(root, {
      chmod,
      mkdir,
      readFile,
      readdir,
      unlink,
      writeFile,
      rename: async (source, destination) => {
        await rename(source, destination);
        if (destination.endsWith(".session_start.json")) await rename(destination, claimed);
      },
    });
    await expect(store.publish(ack())).resolves.toBeUndefined();
    expect((await stat(claimed)).isFile()).toBeTrue();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists only allowlisted structured failure codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-marker-"));
  try {
    const store = createMarkerStore(root);
    const promptFailure = ack({ stage: "before_agent_start", failureCode: "prompt_channel_failed" });
    await store.publish(promptFailure);
    expect(await store.consume(promptFailure.launchId, "before_agent_start")).toEqual(promptFailure);
    const nameFailure = ack({ sessionName: "os · Handoff · 2", failureCode: "session_name_failed" });
    await store.publish(nameFailure);
    expect(await store.consume(nameFailure.launchId, "session_start")).toEqual(nameFailure);
    await expect(store.publish({ ...promptFailure, failureCode: "private-error" } as HandshakeAck)).rejects.toThrow("invalid ack");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed schema, unsafe paths, replayed stages, and expired markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-marker-"));
  try { const store = createMarkerStore(root); await expect(store.publish(ack({ launchId: "../escape" }))).rejects.toThrow(); await writeFile(join(root, `${"b".repeat(32)}.session_start.json`), JSON.stringify(ack({ launchId: "b".repeat(32), timestamp: Date.now() - MARKER_TTL_MS - 1 }))); expect(await store.consume("b".repeat(32), "session_start")).toBeUndefined(); expect(await store.consume("../bad", "session_start")).toBeUndefined(); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("cleanup removes only launch marker family", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-marker-"));
  try { const store = createMarkerStore(root); const id = "c".repeat(32); await store.publish(ack({ launchId: id })); await store.publish(ack({ launchId: id, stage: "before_agent_start" })); await store.publish(ack({ launchId: "d".repeat(32) })); await store.cleanup(id); expect(await readdir(root)).toEqual([`${"d".repeat(32)}.session_start.json`]); }
  finally { await rm(root, { recursive: true, force: true }); }
});
