import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

export type RpcObject = Record<string, unknown>;

export interface RpcReadyFrame extends RpcObject {
	type: "ready";
	protocolVersion: number;
	supportedProtocolVersions?: number[];
	maxFrameBytes?: number;
	maxReassembledFrameBytes?: number;
}

export interface RpcResponseFrame extends RpcObject {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: RpcObject;
	error?: string;
	code?: string;
}

export interface RpcClientOptions {
	command?: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	onStderr?: (text: string) => void;
	readyTimeoutMs?: number;
	startupSignal?: AbortSignal;
}

export interface RpcPromptResult {
	id: string;
	acknowledgement: RpcResponseFrame;
	completion: RpcObject;
	frames: RpcObject[];
}

export type RpcExtensionUiResponse =
	| {
			id: string;
			value: string;
	  }
	| {
			id: string;
			confirmed: boolean;
	  }
	| {
			id: string;
			cancelled: true;
			timedOut?: boolean;
	  };

interface PendingRequest {
	resolve: (frame: RpcResponseFrame) => void;
	reject: (error: Error) => void;
}

interface ActivePrompt {
	id: string;
	frames: RpcObject[];
	resolve: (frame: RpcObject) => void;
	reject: (error: Error) => void;
}

interface PendingChunks {
	chunkId: string;
	count: number;
	byteLength: number;
	nextIndex: number;
	receivedBytes: number;
	chunks: Buffer[];
}

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_ID_LENGTH = 128;
const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;
const HIGH_LEVEL_PROMPT_COMMANDS: Readonly<Record<string, true>> = {
	prompt: true,
	abort_and_prompt: true,
	steer: true,
	follow_up: true,
};
const EXTENSION_UI_RESPONSE_KEYS: Readonly<Record<string, true>> = {
	id: true,
	value: true,
	confirmed: true,
	cancelled: true,
	timedOut: true,
};
const STARTUP_TERMINATE_GRACE_MS = 1_000;
const STARTUP_KILL_GRACE_MS = 2_000;

async function waitForChildClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timeout!: NodeJS.Timeout;
	const deadline = new Promise<false>(resolve => {
		timeout = setTimeout(() => resolve(false), timeoutMs);
		timeout.unref();
	});
	try {
		return await Promise.race([closed.then(() => true as const), deadline]);
	} finally {
		clearTimeout(timeout);
	}
}

async function terminateStartupChild(
	child: ChildProcessWithoutNullStreams,
	closed: Promise<void>,
): Promise<boolean> {
	if (child.exitCode === null && child.signalCode === null) {
		try {
			child.kill("SIGTERM");
		} catch {}
	}
	if (await waitForChildClose(closed, STARTUP_TERMINATE_GRACE_MS)) return true;
	try {
		child.kill("SIGKILL");
	} catch {}
	return await waitForChildClose(closed, STARTUP_KILL_GRACE_MS);
}

function isObject(value: unknown): value is RpcObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function canonicalExtensionUiResponseFrame(response: unknown): RpcObject | Error {
	if (!isObject(response)) return new Error("Extension UI response must be an object");
	if (!Object.hasOwn(response, "id") || typeof response.id !== "string" || response.id.length === 0) {
		return new Error("Extension UI response requires a non-empty string id");
	}
	const id = response.id;
	if (Object.keys(response).some(key => !Object.hasOwn(EXTENSION_UI_RESPONSE_KEYS, key))) {
		return new Error("Extension UI response contains an unsupported field");
	}
	const hasValue = Object.hasOwn(response, "value");
	const hasConfirmed = Object.hasOwn(response, "confirmed");
	const hasCancelled = Object.hasOwn(response, "cancelled");
	if (Number(hasValue) + Number(hasConfirmed) + Number(hasCancelled) !== 1) {
		return new Error("Extension UI response requires exactly one payload variant");
	}
	if (hasValue) {
		const value = response.value;
		if (typeof value !== "string" || Object.hasOwn(response, "timedOut")) {
			return new Error("Extension UI value response requires a string value");
		}
		return { type: "extension_ui_response", id, value };
	}
	if (hasConfirmed) {
		const confirmed = response.confirmed;
		if (typeof confirmed !== "boolean" || Object.hasOwn(response, "timedOut")) {
			return new Error("Extension UI confirmation response requires a boolean confirmed");
		}
		return { type: "extension_ui_response", id, confirmed };
	}
	const cancelled = response.cancelled;
	const hasTimedOut = Object.hasOwn(response, "timedOut");
	const timedOut = hasTimedOut ? response.timedOut : undefined;
	if (cancelled !== true || (hasTimedOut && timedOut !== undefined && typeof timedOut !== "boolean")) {
		return new Error("Extension UI cancellation response requires cancelled true and an optional boolean timedOut");
	}
	const frame: RpcObject = { type: "extension_ui_response", id, cancelled };
	if (hasTimedOut) frame.timedOut = timedOut;
	return frame;
}

function responseError(frame: RpcResponseFrame): Error {
	const suffix = frame.code ? ` (${frame.code})` : "";
	return new Error(`${frame.command} failed${suffix}: ${frame.error ?? "unknown RPC error"}`);
}

function decodeCanonicalBase64(value: unknown): Buffer {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
	) {
		throw new Error("invalid rpc chunk data");
	}
	const bytes = Buffer.from(value, "base64");
	if (bytes.toString("base64") !== value) throw new Error("invalid rpc chunk data");
	return bytes;
}

export function isTerminalAgentEnd(frame: RpcObject): boolean {
	return frame.type === "agent_end" && frame.isTerminal !== false;
}

/** Stateful protocol-v2 decoder. One uninterrupted chunk sequence is allowed at a time. */
export class RpcChunkReassembler {
	#maxFrameBytes = DEFAULT_MAX_FRAME_BYTES;
	#maxReassembledFrameBytes = DEFAULT_MAX_REASSEMBLED_BYTES;
	#pending?: PendingChunks;

	setLimits(maxFrameBytes: unknown, maxReassembledFrameBytes: unknown): void {
		if (positiveSafeInteger(maxFrameBytes)) this.#maxFrameBytes = maxFrameBytes;
		if (positiveSafeInteger(maxReassembledFrameBytes)) {
			this.#maxReassembledFrameBytes = maxReassembledFrameBytes;
		}
		if (this.#maxReassembledFrameBytes < this.#maxFrameBytes) {
			throw new Error("RPC ready frame advertises inconsistent transport limits");
		}
	}

	push(value: unknown): RpcObject | undefined {
		if (!isObject(value)) throw new Error("rpc frame must be an object");
		if (value.type !== "rpc_chunk") {
			if (this.#pending) throw new Error("rpc chunk sequence interrupted");
			return value;
		}

		const { chunkId, index, count, byteLength } = value;
		if (
			typeof chunkId !== "string" ||
			chunkId.length === 0 ||
			chunkId.length > MAX_CHUNK_ID_LENGTH ||
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(count) ||
			!Number.isSafeInteger(byteLength) ||
			(index as number) < 0 ||
			(count as number) < 2 ||
			(count as number) > Math.ceil(this.#maxReassembledFrameBytes / RPC_CHUNK_PAYLOAD_BYTES) ||
			(index as number) >= (count as number) ||
			(byteLength as number) < this.#maxFrameBytes ||
			(byteLength as number) > this.#maxReassembledFrameBytes
		) {
			throw new Error("invalid rpc chunk metadata");
		}

		const bytes = decodeCanonicalBase64(value.data);
		if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) {
			throw new Error("rpc chunk payload exceeds the transport limit");
		}

		if (!this.#pending) {
			if (index !== 0) throw new Error("rpc chunk sequence must start at index 0");
			this.#pending = {
				chunkId,
				count: count as number,
				byteLength: byteLength as number,
				nextIndex: 0,
				receivedBytes: 0,
				chunks: [],
			};
		}

		const pending = this.#pending;
		if (
			pending.chunkId !== chunkId ||
			pending.count !== count ||
			pending.byteLength !== byteLength ||
			pending.nextIndex !== index
		) {
			throw new Error("rpc chunk sequence mismatch");
		}

		pending.chunks.push(bytes);
		pending.receivedBytes += bytes.byteLength;
		pending.nextIndex++;
		if (pending.receivedBytes > pending.byteLength) throw new Error("rpc chunk sequence exceeds declared length");
		if (pending.nextIndex < pending.count) return undefined;
		if (pending.receivedBytes !== pending.byteLength) throw new Error("rpc chunk sequence length mismatch");

		this.#pending = undefined;
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
		const frame: unknown = JSON.parse(decoded);
		if (!isObject(frame)) throw new Error("rpc frame must be an object");
		return frame;
	}
}

export class OmpRpcClient extends EventEmitter {
	readonly #options: Required<Pick<RpcClientOptions, "command" | "args">> & Omit<RpcClientOptions, "command" | "args">;
	#decoder = new RpcChunkReassembler();
	readonly #pending = new Map<string, PendingRequest>();
	#child?: ChildProcessWithoutNullStreams;
	#ready?: RpcReadyFrame;
	#readyResolve?: (frame: RpcReadyFrame) => void;
	#readyReject?: (error: Error) => void;
	#activePrompt?: ActivePrompt;
	#nextRequestId = 0;
	#maxFrameBytes = DEFAULT_MAX_FRAME_BYTES;
	#closing = false;
	readonly #readyTimeoutMs: number;

	constructor(options: RpcClientOptions = {}) {
		super();
		const readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
		if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) {
			throw new Error("readyTimeoutMs must be a positive finite number");
		}
		this.#readyTimeoutMs = readyTimeoutMs;
		this.#options = {
			...options,
			command: options.command ?? "omp",
			args: options.args ?? ["--mode", "rpc"],
		};
	}

	get readyFrame(): RpcReadyFrame | undefined {
		return this.#ready;
	}

	async start(): Promise<RpcReadyFrame> {
		if (this.#child) throw new Error("RPC client already started");
		this.#closing = false;
		const child = spawn(this.#options.command, this.#options.args, {
			cwd: this.#options.cwd,
			env: this.#options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#child = child;
		const closed = new Promise<void>(resolve => child.once("close", () => resolve()));

		const readyPromise = new Promise<RpcReadyFrame>((resolve, reject) => {
			this.#readyResolve = resolve;
			this.#readyReject = reject;
		});
		let startupPhase = "ready";
		const readyTimer = setTimeout(() => {
			this.#fail(new Error(`OMP RPC startup timed out during ${startupPhase} after ${this.#readyTimeoutMs}ms`));
		}, this.#readyTimeoutMs);
		const startupSignal = this.#options.startupSignal;
		const abortStartup = (): void => {
			this.#fail(new Error("OMP RPC startup aborted"));
		};
		if (startupSignal?.aborted) abortStartup();
		else startupSignal?.addEventListener("abort", abortStartup, { once: true });
		const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
		lines.on("line", line => {
			if (line.length === 0) return;
			try {
				this.#handlePhysicalFrame(line);
			} catch (error) {
				this.#fail(error instanceof Error ? error : new Error(String(error)));
				child.kill();
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", text => this.#options.onStderr?.(String(text)));
		child.once("error", error => this.#fail(error));
		child.once("exit", (code, signal) => {
			if (this.#child === child) this.#child = undefined;
			if (!this.#closing) this.#fail(new Error(`OMP RPC exited before close (code=${code}, signal=${signal})`));
			this.emit("exit", code, signal);
		});

		try {
			const ready = await readyPromise;
			startupPhase = "protocol v2 negotiation";
			if (ready.supportedProtocolVersions?.includes(2)) {
				await this.request({ type: "negotiate_protocol", protocolVersion: 2 }, "protocol");
			}
			clearTimeout(readyTimer);
			startupSignal?.removeEventListener("abort", abortStartup);
			return ready;
		} catch (error) {
			clearTimeout(readyTimer);
			startupSignal?.removeEventListener("abort", abortStartup);
			this.#closing = true;
			const reaped = await terminateStartupChild(child, closed);
			this.#resetTransport(child);
			if (!reaped) throw new Error("OMP RPC child did not close after SIGTERM and SIGKILL", { cause: error });
			throw error;
		}
	}

	request(command: RpcObject, idPrefix = "request"): Promise<RpcResponseFrame> {
		if (
			this.#activePrompt &&
			typeof command.type === "string" &&
			HIGH_LEVEL_PROMPT_COMMANDS[command.type]
		) {
			return Promise.reject(
				new Error(`Cannot send ${command.type} while a high-level prompt is active; use abort to cancel it`),
			);
		}
		return this.#requestWithId(command, this.#newId(idPrefix));
	}

	steer(message: string): Promise<RpcResponseFrame> {
		if (typeof message !== "string") return Promise.reject(new Error("steer message must be a string"));
		return this.#requestWithId({ type: "steer", message }, this.#newId("steer"));
	}

	followUp(message: string): Promise<RpcResponseFrame> {
		if (typeof message !== "string") return Promise.reject(new Error("follow-up message must be a string"));
		return this.#requestWithId({ type: "follow_up", message }, this.#newId("follow-up"));
	}

	abort(): Promise<RpcResponseFrame> {
		return this.#requestWithId({ type: "abort" }, this.#newId("abort"));
	}

	respondToExtensionUi(response: RpcExtensionUiResponse): Promise<void> {
		const frame = canonicalExtensionUiResponseFrame(response);
		if (frame instanceof Error) return Promise.reject(frame);
		return this.#writeFrame(frame);
	}

	async prompt(message: string): Promise<RpcPromptResult> {
		if (this.#activePrompt) throw new Error("Only one high-level prompt may be active at a time");
		const id = this.#newId("prompt");
		let resolveCompletion!: (frame: RpcObject) => void;
		let rejectCompletion!: (error: Error) => void;
		const completionPromise = new Promise<RpcObject>((resolve, reject) => {
			resolveCompletion = resolve;
			rejectCompletion = reject;
		});
		// The ack and completion can reject in the same dispatch. Attach a handler
		// immediately so an ack failure cannot orphan completion as unhandled.
		void completionPromise.catch(() => undefined);
		const active: ActivePrompt = {
			id,
			frames: [],
			resolve: resolveCompletion,
			reject: rejectCompletion,
		};
		this.#activePrompt = active;

		try {
			const acknowledgement = await this.#requestWithId({ type: "prompt", message }, id);
			const completion = await completionPromise;
			return { id, acknowledgement, completion, frames: [...active.frames] };
		} finally {
			if (this.#activePrompt === active) this.#activePrompt = undefined;
		}
	}

	async close(): Promise<void> {
		const child = this.#child;
		if (!child) return;
		this.#closing = true;
		const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
		child.stdin.end();
		await closed;
		this.#resetTransport(child);
	}

	#resetTransport(child: ChildProcessWithoutNullStreams): void {
		if (this.#child === child) this.#child = undefined;
		this.#ready = undefined;
		this.#readyResolve = undefined;
		this.#readyReject = undefined;
		const resetError = new Error("OMP RPC transport reset");
		for (const pending of this.#pending.values()) pending.reject(resetError);
		this.#pending.clear();
		this.#activePrompt?.reject(resetError);
		this.#activePrompt = undefined;
		this.#decoder = new RpcChunkReassembler();
		this.#maxFrameBytes = DEFAULT_MAX_FRAME_BYTES;
		this.#closing = false;
	}

	#newId(prefix: string): string {
		this.#nextRequestId++;
		return `${prefix}-${this.#nextRequestId}`;
	}

	#requestWithId(command: RpcObject, id: string): Promise<RpcResponseFrame> {
		if (typeof command.type !== "string" || command.type.length === 0) {
			return Promise.reject(new Error("RPC command requires a string type"));
		}
		if (this.#pending.has(id)) return Promise.reject(new Error(`Duplicate RPC request id: ${id}`));
		const frame = { ...command, id };

		return new Promise<RpcResponseFrame>((resolve, reject) => {
			const pending = { resolve, reject };
			this.#pending.set(id, pending);
			void this.#writeFrame(frame).catch(error => {
				if (this.#pending.get(id) !== pending) return;
				this.#pending.delete(id);
				reject(error);
			});
		});
	}

	#writeFrame(frame: RpcObject): Promise<void> {
		const stdin = this.#child?.stdin;
		if (!stdin?.writable || stdin.destroyed || stdin.writableEnded) {
			return Promise.reject(new Error("RPC client is not running"));
		}
		let line: string;
		try {
			line = `${JSON.stringify(frame)}\n`;
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		if (Buffer.byteLength(line, "utf8") > this.#maxFrameBytes) {
			return Promise.reject(new Error("RPC outbound frame exceeds the advertised physical frame limit"));
		}
		return new Promise<void>((resolve, reject) => {
			stdin.write(line, "utf8", error => {
				if (error) reject(error);
				else resolve();
			});
		});
	}

	#handlePhysicalFrame(line: string): void {
		if (Buffer.byteLength(line, "utf8") + 1 > this.#maxFrameBytes) {
			throw new Error("RPC physical frame exceeds the advertised limit");
		}
		const parsed: unknown = JSON.parse(line);
		const frame = this.#decoder.push(parsed);
		if (frame) this.#handleLogicalFrame(frame);
	}

	#handleLogicalFrame(frame: RpcObject): void {
		if (frame.type === "ready") {
			if (this.#ready) throw new Error("duplicate RPC ready frame");
			const ready = frame as RpcReadyFrame;
			if (!positiveSafeInteger(ready.protocolVersion)) throw new Error("invalid RPC ready protocolVersion");
			this.#decoder.setLimits(ready.maxFrameBytes, ready.maxReassembledFrameBytes);
			if (positiveSafeInteger(ready.maxFrameBytes)) this.#maxFrameBytes = ready.maxFrameBytes;
			this.#ready = ready;
			this.#readyResolve?.(ready);
			this.#readyResolve = undefined;
			this.#readyReject = undefined;
			this.emit("frame", ready);
			return;
		}

		this.emit("frame", frame);
		if (this.#activePrompt) this.#activePrompt.frames.push(frame);

		if (frame.type === "response") {
			const response = frame as RpcResponseFrame;
			if (typeof response.id !== "string") {
				if (response.success === false) {
					const suffix = response.code ? ` (${response.code})` : "";
					this.#fail(
						new Error(
							`Uncorrelated RPC failure from ${response.command}${suffix}: ${response.error ?? "unknown RPC error"}`,
						),
					);
				}
				return;
			}
			const pending = this.#pending.get(response.id);
			if (pending) {
				this.#pending.delete(response.id);
				if (response.success) pending.resolve(response);
				else pending.reject(responseError(response));
			}
			if (this.#activePrompt?.id === response.id) {
				if (!response.success) this.#activePrompt.reject(responseError(response));
				else if (response.data?.agentInvoked === false) this.#activePrompt.resolve(response);
			}
			return;
		}

		if (
			frame.type === "prompt_result" &&
			frame.id === this.#activePrompt?.id &&
			frame.agentInvoked === false
		) {
			this.#activePrompt.resolve(frame);
			return;
		}
		if (this.#activePrompt && isTerminalAgentEnd(frame)) this.#activePrompt.resolve(frame);
	}

	#fail(error: Error): void {
		this.#readyReject?.(error);
		this.#readyResolve = undefined;
		this.#readyReject = undefined;
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		this.#activePrompt?.reject(error);
		this.emit("protocolError", error);
	}
}
