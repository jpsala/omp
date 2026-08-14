import { expect, test } from "bun:test";
import {
  consumePromptChannel,
  MAX_PROMPT_BYTES,
  openPromptChannel,
  PROMPT_CHANNEL_HASH_ENV,
  PROMPT_CHANNEL_URL_ENV,
} from "../src/runtime-prompt-channel.ts";

test("delivers one exact unicode multiline prompt over loopback", async () => {
  const prompt = "primera á\nsegunda\n".repeat(2_000);
  const channel = await openPromptChannel(prompt);
  try {
    expect(await consumePromptChannel(channel.environment)).toBe(prompt);
  } finally {
    await channel.close();
  }
});

test("rejects incomplete, remote, and hash-mismatched channel metadata", async () => {
  await expect(consumePromptChannel({ [PROMPT_CHANNEL_URL_ENV]: "http://127.0.0.1:1/" })).rejects.toThrow("incomplete");
  await expect(consumePromptChannel({
    [PROMPT_CHANNEL_URL_ENV]: `http://example.com:80/${"a".repeat(64)}`,
    [PROMPT_CHANNEL_HASH_ENV]: "b".repeat(64),
  })).rejects.toThrow("loopback");

  const channel = await openPromptChannel("exact prompt");
  try {
    await expect(consumePromptChannel({
      ...channel.environment,
      [PROMPT_CHANNEL_HASH_ENV]: "0".repeat(64),
    })).rejects.toThrow("hash mismatch");
  } finally {
    await channel.close();
  }
});

test("rejects empty and oversized prompts before binding", async () => {
  await expect(openPromptChannel("")).rejects.toThrow("1..");
  await expect(openPromptChannel("x".repeat(MAX_PROMPT_BYTES + 1))).rejects.toThrow("1..");
});
