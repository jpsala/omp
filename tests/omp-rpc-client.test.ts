import { describe, expect, test } from "bun:test";
import {
	OmpRpcClient,
	RpcChunkReassembler,
	isTerminalAgentEnd,
	type RpcExtensionUiResponse,
	type RpcObject,
} from "../src/omp-rpc-client.ts";

function chunkLogicalFrame(frame: RpcObject, chunkId = "test-chunk", segmentBytes = 8): RpcObject[] {
	const bytes = Buffer.from(JSON.stringify(frame), "utf8");
	const count = Math.ceil(bytes.byteLength / segmentBytes);
	return Array.from({ length: count }, (_, index) => ({
		type: "rpc_chunk",
		chunkId,
		index,
		count,
		byteLength: bytes.byteLength,
		data: bytes.subarray(index * segmentBytes, (index + 1) * segmentBytes).toString("base64"),
	}));
}

describe("RpcChunkReassembler", () => {
	test("reassembles ordered canonical base64 into one logical object", () => {
		const decoder = new RpcChunkReassembler();
		decoder.setLimits(16, 4 * 1024 * 1024);
		const expected = { type: "agent_end", isTerminal: true, message: "á".repeat(20) };
		const chunks = chunkLogicalFrame(expected, "ordered", 12);
		for (const chunk of chunks.slice(0, -1)) expect(decoder.push(chunk)).toBeUndefined();
		expect(decoder.push(chunks.at(-1))).toEqual(expected);
	});

	test("rejects an interrupted chunk sequence", () => {
		const decoder = new RpcChunkReassembler();
		decoder.setLimits(16, 4 * 1024 * 1024);
		const [first] = chunkLogicalFrame({ type: "large", body: "x".repeat(80) }, "interrupted", 12);
		decoder.push(first);
		expect(() => decoder.push({ type: "notice" })).toThrow("rpc chunk sequence interrupted");
	});
});

test("terminal agent_end treats an absent isTerminal as backward-compatible", () => {
	expect(isTerminalAgentEnd({ type: "agent_end", isTerminal: false })).toBe(false);
	expect(isTerminalAgentEnd({ type: "agent_end", isTerminal: true })).toBe(true);
	expect(isTerminalAgentEnd({ type: "agent_end" })).toBe(true);
});

test("client negotiates v2, correlates out-of-order responses and waits for terminal agent_end", async () => {
	const fakeServer = String.raw`
const { createInterface } = require("node:readline");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = frame => process.stdout.write(JSON.stringify(frame) + "\n");
const sendChunked = frame => {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const segmentBytes = 256;
  const count = Math.ceil(bytes.byteLength / segmentBytes);
  for (let index = 0; index < count; index++) {
    send({
      type: "rpc_chunk",
      chunkId: "terminal-1",
      index,
      count,
      byteLength: bytes.byteLength,
      data: bytes.subarray(index * segmentBytes, (index + 1) * segmentBytes).toString("base64"),
    });
  }
};
send({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 512,
  maxReassembledFrameBytes: 1024 * 1024,
});
let pendingState;
lines.on("line", line => {
  const command = JSON.parse(line);
  if (command.type === "negotiate_protocol") {
    send({ id: command.id, type: "response", command: command.type, success: true, data: { protocolVersion: 2 } });
  } else if (command.type === "get_state") {
    pendingState = command;
  } else if (command.type === "get_available_commands") {
    send({ id: command.id, type: "response", command: command.type, success: true, data: { marker: "commands" } });
    send({ id: pendingState.id, type: "response", command: pendingState.type, success: true, data: { marker: "state" } });
  } else if (command.type === "prompt") {
    send({ id: command.id, type: "response", command: command.type, success: true, data: { agentInvoked: true } });
    send({ type: "agent_end", messages: [], isTerminal: false });
    sendChunked({ type: "agent_end", messages: [], isTerminal: true, padding: "x".repeat(800) });
  }
});
`;
	const client = new OmpRpcClient({ command: process.execPath, args: ["-e", fakeServer] });
	try {
		const ready = await client.start();
		expect(ready.supportedProtocolVersions).toContain(2);

		const statePromise = client.request({ type: "get_state" }, "state");
		const commandsPromise = client.request({ type: "get_available_commands" }, "commands");
		const [state, commands] = await Promise.all([statePromise, commandsPromise]);
		expect(state.data?.marker).toBe("state");
		expect(commands.data?.marker).toBe("commands");

		const promptPromise = client.prompt("hello");
		const conflicting = ["prompt", "abort_and_prompt", "steer", "follow_up"].map(type =>
			client.request({ type }, "conflict"),
		);
		const conflictResults = await Promise.allSettled(conflicting);
		expect(conflictResults.map(result => result.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
		for (const conflict of conflictResults) {
			if (conflict.status === "rejected") expect(String(conflict.reason)).toContain("high-level prompt is active");
		}
		const result = await promptPromise;
		expect(result.acknowledgement.data?.agentInvoked).toBe(true);
		expect(result.completion.type).toBe("agent_end");
		expect(result.completion.isTerminal).toBe(true);
		expect(result.frames.some(frame => frame.type === "agent_end" && frame.isTerminal === false)).toBe(true);
	} finally {
		await client.close();
	}
});

test("an uncorrelated failure rejects every pending request without guessing an owner", async () => {
	const fakeServer = String.raw`
const { createInterface } = require("node:readline");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdout.write(JSON.stringify({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
}) + "\n");
lines.on("line", line => {
  const command = JSON.parse(line);
  if (command.type === "unknown_contract_probe") {
    process.stdout.write(JSON.stringify({
      type: "response",
      command: command.type,
      success: false,
      error: "Unknown command",
    }) + "\n");
  }
});
`;
	const client = new OmpRpcClient({ command: process.execPath, args: ["-e", fakeServer] });
	try {
		await client.start();
		const held = client.request({ type: "get_state" }, "held");
		const unknown = client.request({ type: "unknown_contract_probe" }, "unknown");
		const settled = await Promise.allSettled([held, unknown]);
		expect(settled.map(result => result.status)).toEqual(["rejected", "rejected"]);
		for (const result of settled) {
			if (result.status === "rejected") {
				expect(String(result.reason)).toContain("Uncorrelated RPC failure from unknown_contract_probe");
			}
		}
	} finally {
		await client.close();
	}
});

test("startup cancellation reaps the child and resets transport state", async () => {
	const controller = new AbortController();
	controller.abort();
	const client = new OmpRpcClient({
		command: process.execPath,
		args: ["-e", "process.stdin.resume()"],
		readyTimeoutMs: 10_000,
		startupSignal: controller.signal,
	});
	try {
		await expect(client.start()).rejects.toThrow("startup aborted");
		expect(client.readyFrame).toBeUndefined();
	} finally {
		await client.close();
	}
});

test("protocol negotiation failure reaps the child and resets ready state", async () => {
	const fakeServer = String.raw`
const { createInterface } = require("node:readline");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdout.write(JSON.stringify({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
}) + "\n");
lines.on("line", line => {
  const command = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    id: command.id,
    type: "response",
    command: command.type,
    success: false,
    error: "v2 disabled for probe",
  }) + "\n");
});
`;
	const client = new OmpRpcClient({ command: process.execPath, args: ["-e", fakeServer] });
	await expect(client.start()).rejects.toThrow("v2 disabled for probe");
	expect(client.readyFrame).toBeUndefined();
	await client.close();
});


test("id-less failure before prompt ack does not orphan completion as unhandled", async () => {
	const fakeServer = String.raw`
const { createInterface } = require("node:readline");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = frame => process.stdout.write(JSON.stringify(frame) + "\n");
send({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
});
lines.on("line", line => {
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    send({
      type: "response",
      command: "parse",
      success: false,
      error: "uncorrelated parse failure",
    });
  }
});
`;
	const client = new OmpRpcClient({ command: process.execPath, args: ["-e", fakeServer] });
	try {
		await client.start();
		const prompt = client.prompt("hello");
		const trigger = client.request({ type: "get_state" }, "trigger");
		const settled = await Promise.allSettled([prompt, trigger]);
		expect(settled.map(result => result.status)).toEqual(["rejected", "rejected"]);
		for (const result of settled) {
			if (result.status === "rejected") {
				expect(String(result.reason)).toContain("Uncorrelated RPC failure from parse");
			}
		}
	} finally {
		await client.close();
	}
});

test("steer, follow-up, and abort stay correlated while a prompt waits for terminal completion", async () => {
	const fakeServer = String.raw`
const { createInterface } = require("node:readline");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = frame => process.stdout.write(JSON.stringify(frame) + "\n");
send({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
});
let pendingSteer;
lines.on("line", line => {
  const command = JSON.parse(line);
  if (command.type === "prompt") {
    send({ id: command.id, type: "response", command: command.type, success: true, data: { agentInvoked: true } });
    send({ type: "agent_end", messages: [], isTerminal: false });
  } else if (command.type === "steer") {
    pendingSteer = command;
  } else if (command.type === "follow_up") {
    send({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      data: { received: command.message },
    });
    send({
      id: pendingSteer.id,
      type: "response",
      command: pendingSteer.type,
      success: true,
      data: { received: pendingSteer.message },
    });
  } else if (command.type === "abort") {
    send({ id: command.id, type: "response", command: command.type, success: true });
  } else if (command.type === "get_state") {
    send({ id: command.id, type: "response", command: command.type, success: true });
    send({ type: "agent_end", messages: [], isTerminal: true });
  }
});
`;
	const client = new OmpRpcClient({ command: process.execPath, args: ["-e", fakeServer] });
	try {
		await client.start();
		let promptSettled = false;
		const promptPromise = client.prompt("primary").then(result => {
			promptSettled = true;
			return result;
		});
		const steerPromise = client.steer("change course");
		const followUpPromise = client.followUp("then summarize");
		const [steer, followUp] = await Promise.all([steerPromise, followUpPromise]);

		expect(steer.command).toBe("steer");
		expect(steer.data?.received).toBe("change course");
		expect(followUp.command).toBe("follow_up");
		expect(followUp.data?.received).toBe("then summarize");
		expect(steer.id).not.toBe(followUp.id);
		expect(promptSettled).toBe(false);

		const abort = await client.abort();
		expect(abort.command).toBe("abort");
		expect(promptSettled).toBe(false);

		await client.request({ type: "get_state" }, "settle");
		const result = await promptPromise;
		expect(result.completion).toMatchObject({ type: "agent_end", isTerminal: true });
		expect(result.frames.some(frame => frame.type === "agent_end" && frame.isTerminal === false)).toBe(true);
	} finally {
		await client.close();
	}
});

test("extension UI responses preserve exact ids and payloads without awaiting command responses", async () => {
	const fakeServer = String.raw`
const { createInterface } = require("node:readline");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = frame => process.stdout.write(JSON.stringify(frame) + "\n");
send({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
});
const responses = [];
lines.on("line", line => {
  const frame = JSON.parse(line);
  if (frame.type === "extension_ui_response") {
    responses.push(frame);
    if (responses.length === 3) send({ type: "captured_extension_ui_responses", responses });
  } else if (frame.type === "get_state") {
    send({ id: frame.id, type: "response", command: frame.type, success: true, data: { responsive: true } });
  }
});
`;
	const client = new OmpRpcClient({ command: process.execPath, args: ["-e", fakeServer] });
	try {
		const capturedPromise = new Promise<RpcObject>(resolve => {
			client.on("frame", frame => {
				if (frame.type === "captured_extension_ui_responses") resolve(frame);
			});
		});
		await client.start();
		const valueResponse = Object.assign(Object.create({ confirmed: true, inherited: "must-not-leak" }), {
			value: "feature/rpc-host",
		}) as RpcExtensionUiResponse;
		Object.defineProperty(valueResponse, "id", { value: "ui-value", enumerable: false });
		await client.respondToExtensionUi(valueResponse);
		await client.respondToExtensionUi({ id: "ui-confirm", confirmed: false });
		await client.respondToExtensionUi({ id: "ui-cancel", cancelled: true, timedOut: true });

		const captured = await capturedPromise;
		expect(captured.responses).toEqual([
			{ type: "extension_ui_response", id: "ui-value", value: "feature/rpc-host" },
			{ type: "extension_ui_response", id: "ui-confirm", confirmed: false },
			{ type: "extension_ui_response", id: "ui-cancel", cancelled: true, timedOut: true },
		]);
		const state = await client.request({ type: "get_state" }, "after-ui");
		expect(state.data?.responsive).toBe(true);

		await expect(client.respondToExtensionUi({ id: "", confirmed: true })).rejects.toThrow("non-empty string id");
		const inheritedIdResponse = Object.assign(Object.create({ id: "ui-inherited" }), {
			confirmed: true,
		}) as RpcExtensionUiResponse;
		await expect(client.respondToExtensionUi(inheritedIdResponse)).rejects.toThrow("non-empty string id");
		for (const response of [
			{ id: "ui-undefined-confirmed", value: "one", confirmed: undefined },
			{ id: "ui-undefined-cancelled", confirmed: true, cancelled: undefined },
			{ id: "ui-undefined-value", cancelled: true, value: undefined },
		]) {
			await expect(
				client.respondToExtensionUi(response as unknown as RpcExtensionUiResponse),
			).rejects.toThrow("exactly one payload variant");
		}
		await expect(
			client.respondToExtensionUi({
				id: "ui-invalid",
				value: "one",
				confirmed: true,
			} as unknown as RpcExtensionUiResponse),
		).rejects.toThrow("exactly one payload variant");
	} finally {
		await client.close();
	}
});

test("the bounded writer rejects oversized commands and extension UI responses", async () => {
	const fakeServer = String.raw`
const { createInterface } = require("node:readline");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = frame => process.stdout.write(JSON.stringify(frame) + "\n");
send({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1],
  maxFrameBytes: 256,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
});
lines.on("line", line => {
  const command = JSON.parse(line);
  send({ id: command.id, type: "response", command: command.type, success: true });
});
`;
	const client = new OmpRpcClient({ command: process.execPath, args: ["-e", fakeServer] });
	try {
		await client.start();
		await expect(client.steer("x".repeat(512))).rejects.toThrow("advertised physical frame limit");
		await expect(
			client.respondToExtensionUi({ id: "ui-oversized", value: "x".repeat(512) }),
		).rejects.toThrow("advertised physical frame limit");
		await expect(client.steer(42 as never)).rejects.toThrow("steer message must be a string");
		await expect(client.followUp(null as never)).rejects.toThrow("follow-up message must be a string");
		const abort = await client.abort();
		expect(abort.command).toBe("abort");
	} finally {
		await client.close();
	}
});

test("host controls reject writes after the RPC transport closes", async () => {
	const fakeServer = String.raw`
process.stdout.write(JSON.stringify({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
}) + "\n");
process.stdin.resume();
`;
	const client = new OmpRpcClient({ command: process.execPath, args: ["-e", fakeServer] });
	await client.start();
	await client.close();

	const settled = await Promise.allSettled([
		client.steer("late steer"),
		client.followUp("late follow-up"),
		client.abort(),
		client.respondToExtensionUi({ id: "ui-late", confirmed: true }),
	]);
	expect(settled.map(result => result.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
	for (const result of settled) {
		if (result.status === "rejected") expect(String(result.reason)).toContain("RPC client is not running");
	}
});