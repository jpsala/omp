import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { promptSha256 } from "./runtime-handshake.ts";

export const PROMPT_CHANNEL_URL_ENV = "OMP_RUNTIME_PROMPT_URL";
export const PROMPT_CHANNEL_HASH_ENV = "OMP_RUNTIME_PROMPT_SHA256";
export const MAX_PROMPT_BYTES = 1024 * 1024;
const CHANNEL_TIMEOUT_MS = 30_000;

export interface PromptChannelHandle {
  environment: Record<string, string>;
  close(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  return promise;
}

export async function openPromptChannel(prompt: string): Promise<PromptChannelHandle> {
  const bytes = Buffer.from(prompt, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_PROMPT_BYTES) {
    throw new Error(`prompt must contain 1..${MAX_PROMPT_BYTES} UTF-8 bytes`);
  }
  const token = randomBytes(32).toString("hex");
  const path = `/${token}`;
  let delivered = false;
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== path || delivered) {
      response.writeHead(404).end();
      return;
    }
    delivered = true;
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(bytes.length),
      "cache-control": "no-store",
    });
    response.end(bytes, () => void closeServer(server));
  });
  server.unref();
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("prompt channel did not bind an IPv4 port");
  }
  return {
    environment: {
      [PROMPT_CHANNEL_URL_ENV]: `http://127.0.0.1:${address.port}${path}`,
      [PROMPT_CHANNEL_HASH_ENV]: promptSha256(prompt),
    },
    close: () => closeServer(server),
  };
}

function validatedChannelUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !/^\d+$/.test(url.port) ||
    !/^\/[a-f0-9]{64}$/.test(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("prompt channel URL must be a tokenized IPv4 loopback endpoint");
  }
  return url;
}

export async function consumePromptChannel(environment: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const rawUrl = environment[PROMPT_CHANNEL_URL_ENV];
  const expectedHash = environment[PROMPT_CHANNEL_HASH_ENV];
  if (rawUrl === undefined && expectedHash === undefined) return undefined;
  if (!rawUrl || !expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error("prompt channel environment is incomplete");
  }
  const url = validatedChannelUrl(rawUrl);
  const response = await fetch(url, {
    headers: { accept: "text/plain" },
    signal: AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`prompt channel returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > MAX_PROMPT_BYTES) {
    throw new Error("prompt channel returned an invalid content length");
  }
  const prompt = await response.text();
  if (Buffer.byteLength(prompt, "utf8") !== declaredLength) {
    throw new Error("prompt channel response length mismatch");
  }
  if (promptSha256(prompt) !== expectedHash) {
    throw new Error("prompt channel hash mismatch");
  }
  return prompt;
}
