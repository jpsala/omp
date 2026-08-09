import { appendFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	OmpRpcClient,
	type RpcExtensionUiResponse,
	type RpcObject,
	type RpcPromptResult,
	type RpcReadyFrame,
	type RpcResponseFrame,
} from "./omp-rpc-client.ts";
import {
	composeFleetPrompt,
	validateFleetConfig,
	type FleetConfig,
	type FleetRepoConfig,
	type FleetWindowMode,
} from "./omp-fleet-config.ts";

export type FleetWorkerState = "pending" | "starting" | "running" | "succeeded" | "failed" | "aborted";

export interface FleetFrameSummary {
	type: string;
	id?: string;
	method?: string;
	command?: string;
	success?: boolean;
	isTerminal?: boolean;
	code?: string;
}

export interface FleetPendingUiRequest {
	repo: string;
	id: string;
	version: number;
	method: string;
	title?: string;
	message?: string;
	placeholder?: string;
	options?: unknown[];
	prefill?: string;
}

export interface FleetWorkerResult {
	repo: string;
	text: string | null;
	completedAt: string;
}
export interface FleetPersistedResultSummary {
	repo: string;
	state: "succeeded";
	completedAt: string;
}


export interface FleetWorkerSnapshot {
	repo: string;
	cwd: string;
	state: FleetWorkerState;
	closed: boolean;
	error?: string;
	result?: FleetWorkerResult;
	lastFrame?: FleetFrameSummary;
	pendingRequests: FleetPendingUiRequest[];
}

export interface FleetSnapshot {
	runId: string;
	name: string;
	window: FleetWindowMode;
	maxConcurrency: number;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	closed: boolean;
	persistenceError?: string;
	workers: FleetWorkerSnapshot[];
}
export interface FleetPersistedWorkerSnapshot {
	repo: string;
	state: FleetWorkerState;
	closed: boolean;
	lastFrame?: FleetFrameSummary;
	pendingRequests: Array<Pick<FleetPendingUiRequest, "repo" | "id" | "method">>;
}

export interface FleetPersistedSnapshot {
	runId: string;
	name: string;
	window: FleetWindowMode;
	maxConcurrency: number;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	closed: boolean;
	workers: FleetPersistedWorkerSnapshot[];
}


export interface FleetEvent {
	sequence: number;
	time: string;
	runId: string;
	type:
		| "run_started"
		| "worker_state"
		| "worker_frame"
		| "ui_request"
		| "ui_response"
		| "result"
		| "warning"
		| "run_finished"
		| "run_closed";
	repo?: string;
	data?: Record<string, unknown>;
}

export interface FleetRpcClient {
	start(): Promise<RpcReadyFrame | RpcObject>;
	prompt(message: string): Promise<RpcPromptResult>;
	request(command: RpcObject, idPrefix?: string): Promise<RpcResponseFrame>;
	steer(message: string): Promise<RpcResponseFrame>;
	followUp(message: string): Promise<RpcResponseFrame>;
	abort(): Promise<RpcResponseFrame>;
	respondToExtensionUi(response: RpcExtensionUiResponse): Promise<void>;
	close(): Promise<void>;
	on(event: "frame", listener: (frame: RpcObject) => void): unknown;
	off?(event: "frame", listener: (frame: RpcObject) => void): unknown;
}

export interface FleetWorkerEnvContext {
	repo: string;
	cwd: string;
	runId: string;
}

export interface FleetClientFactoryContext extends FleetWorkerEnvContext {
	env: NodeJS.ProcessEnv;
}

export type FleetWorkerEnvPolicy = (context: FleetWorkerEnvContext) => NodeJS.ProcessEnv;
export type FleetClientFactory = (context: FleetClientFactoryContext) => FleetRpcClient | Promise<FleetRpcClient>;

export interface FleetFileSystem {
	mkdir(path: string, options: { recursive: true }): Promise<unknown>;
	stat(path: string): Promise<{ isDirectory(): boolean }>;
	appendFile(path: string, data: string, encoding: BufferEncoding): Promise<unknown>;
	writeFile(path: string, data: string, encoding: BufferEncoding): Promise<unknown>;
	rename(from: string, to: string): Promise<unknown>;
}

export interface OmpFleetOptions {
	clientFactory?: FleetClientFactory;
	fileSystem?: FleetFileSystem;
	runRoot?: string;
	clock?: () => Date | string;
	idSource?: () => string;
	envPolicy?: FleetWorkerEnvPolicy;
}

interface WorkerRuntime {
	repo: string;
	config: FleetRepoConfig;
	state: FleetWorkerState;
	closed: boolean;
	abortRequested: boolean;
	abortOutcome?: Promise<RpcResponseFrame | void>;
	client?: FleetRpcClient;
	frameListener?: (frame: RpcObject) => void;
	error?: string;
	result?: FleetWorkerResult;
	lastFrame?: FleetFrameSummary;
	nextPendingVersion: number;
	pending: Map<string, FleetPendingUiRequest & { responseMethod: string }>;
}

/** Environment needed to locate OMP and the installed user profile, excluding code-injection and credential variables. */
export const FLEET_WORKER_ENV_ALLOWLIST = [
	"APPDATA",
	"COLORTERM",
	"COMSPEC",
	"HOME",
	"LANG",
	"LC_ALL",
	"LOCALAPPDATA",
	"PATH",
	"PATHEXT",
	"SHELL",
	"SYSTEMROOT",
	"TEMP",
	"TERM",
	"TMP",
	"USERPROFILE",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
] as const;

export function defaultFleetWorkerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of FLEET_WORKER_ENV_ALLOWLIST) {
		const value = source[key];
		if (typeof value === "string") env[key] = value;
	}
	return env;
}

const INTERACTIVE_UI_METHODS: Record<string, true> = {
	confirm: true,
	editor: true,
	input: true,
	select: true,
};
const INTERACTIVE_UI_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;


function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function summarizeRpcFrame(frame: RpcObject): FleetFrameSummary {
	return {
		type: typeof frame.type === "string" ? frame.type : "unknown",
		...(typeof frame.id === "string" ? { id: frame.id } : {}),
		...(typeof frame.method === "string" ? { method: frame.method } : {}),
		...(typeof frame.command === "string" ? { command: frame.command } : {}),
		...(typeof frame.success === "boolean" ? { success: frame.success } : {}),
		...(typeof frame.isTerminal === "boolean" ? { isTerminal: frame.isTerminal } : {}),
		...(typeof frame.code === "string" ? { code: frame.code } : {}),
	};
}

function assistantText(response: RpcResponseFrame): string | null {
	const text = response.data?.text;
	if (text === null || typeof text === "string") return text;
	throw new Error("get_last_assistant_text returned an invalid payload");
}

function defaultClientFactory(context: FleetClientFactoryContext): FleetRpcClient {
	return new OmpRpcClient({ cwd: context.cwd, env: context.env });
}

const DEFAULT_FILE_SYSTEM: FleetFileSystem = { mkdir, appendFile, writeFile, rename, stat };
const DEFAULT_RUN_ROOT = fileURLToPath(new URL("../artifacts/fleet", import.meta.url));

export class OmpFleetRun {
	readonly config: FleetConfig;
	readonly runId: string;
	readonly runDirectory: string;
	readonly #clientFactory: FleetClientFactory;
	readonly #fileSystem: FleetFileSystem;
	readonly #clock: () => Date | string;
	readonly #workers = new Map<string, WorkerRuntime>();
	readonly #envPolicy: FleetWorkerEnvPolicy;
	readonly #listeners = new Set<(event: FleetEvent) => void>();
	readonly #createdAt: string;
	#startedAt?: string;
	#finishedAt?: string;
	#sequence = 0;
	#atomicSequence = 0;
	#startPromise?: Promise<FleetSnapshot>;
	#persistenceTail: Promise<void> = Promise.resolve();
	#persistenceError?: string;
	#closePromise?: Promise<void>;
	#closing = false;
	#closed = false;
	readonly #closeStarted = Promise.withResolvers<void>();

	constructor(config: FleetConfig, options: OmpFleetOptions = {}) {
		this.config = validateFleetConfig(config);
		this.#clock = options.clock ?? (() => new Date());
		const suppliedId = options.idSource?.() ?? randomUUID();
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(suppliedId)) {
			throw new Error("fleet run id must contain only letters, digits, dot, underscore, and dash");
		}
		this.runId = suppliedId;
		this.runDirectory = resolve(options.runRoot ?? DEFAULT_RUN_ROOT, suppliedId);
		this.#clientFactory = options.clientFactory ?? defaultClientFactory;
		this.#envPolicy = options.envPolicy ?? (() => defaultFleetWorkerEnv());
		this.#fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
		this.#createdAt = this.#now();
		for (const [repo, repoConfig] of Object.entries(this.config.repos)) {
			if (repoConfig.enabled === false) continue;
			this.#workers.set(repo, {
				repo,
				config: repoConfig,
				state: "pending",
				closed: false,
				abortRequested: false,
				nextPendingVersion: 0,
				pending: new Map(),
			});
		}
		if (this.#workers.size === 0) throw new Error("fleet config must enable at least one repository");
	}

	subscribe(listener: (event: FleetEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	getSnapshot(): FleetSnapshot {
		return {
			runId: this.runId,
			name: this.config.name,
			window: this.config.window,
			maxConcurrency: Math.min(this.config.maxConcurrency ?? 4, this.#workers.size),
			createdAt: this.#createdAt,
			...(this.#startedAt ? { startedAt: this.#startedAt } : {}),
			...(this.#finishedAt ? { finishedAt: this.#finishedAt } : {}),
			closed: this.#closed,
			...(this.#persistenceError ? { persistenceError: this.#persistenceError } : {}),
			workers: [...this.#workers.values()].map(worker => ({
				repo: worker.repo,
				cwd: worker.config.cwd,
				state: worker.state,
				closed: worker.closed,
				...(worker.error ? { error: worker.error } : {}),
				...(worker.result ? { result: { ...worker.result } } : {}),
				...(worker.lastFrame ? { lastFrame: { ...worker.lastFrame } } : {}),
				pendingRequests: [...worker.pending.values()].map(({ responseMethod: _responseMethod, ...request }) => ({
					...request,
					...(request.options ? { options: [...request.options] } : {}),
				})),
			})),
		};
	}

	getResults(): Record<string, FleetWorkerResult> {
		const results = new Map<string, FleetWorkerResult>();
		for (const worker of this.#workers.values()) {
			if (worker.result) results.set(worker.repo, { ...worker.result });
		}
		return Object.fromEntries(results);
	}

	getPendingRequest(repo: string, requestId: string): FleetPendingUiRequest | undefined {
		const pending = this.#requireWorker(repo).pending.get(requestId);
		if (!pending) return undefined;
		const { responseMethod: _responseMethod, ...request } = pending;
		return structuredClone(request);
	}

	start(): Promise<FleetSnapshot> {
		if (this.#startPromise) return this.#startPromise;
		this.#startPromise = this.#run();
		return this.#startPromise;
	}

	async steer(repo: string, message: string): Promise<RpcResponseFrame> {
		return this.#activeClient(repo).steer(message);
	}

	async followUp(repo: string, message: string): Promise<RpcResponseFrame> {
		return this.#activeClient(repo).followUp(message);
	}

	abort(repo: string): Promise<RpcResponseFrame | void> {
		const worker = this.#requireWorker(repo);
		if (worker.abortOutcome) return worker.abortOutcome;
		if (worker.state === "pending" || worker.state === "starting") {
			const wasPending = worker.state === "pending";
			worker.abortRequested = true;
			worker.state = "aborted";
			if (wasPending) worker.closed = true;
			this.#emit("worker_state", worker.repo, { state: worker.state });
			worker.abortOutcome = worker.client ? this.#closeWorker(worker) : Promise.resolve();
			return worker.abortOutcome;
		}
		const client = this.#activeClient(repo);
		const shared = Promise.withResolvers<RpcResponseFrame>();
		worker.abortOutcome = shared.promise;
		void (async () => {
			try {
				const response = await client.abort();
				worker.abortRequested = true;
				shared.resolve(response);
			} catch (error) {
				if (worker.abortOutcome === shared.promise) worker.abortOutcome = undefined;
				shared.reject(error);
			}
		})();
		return shared.promise;
	}

	async approve(repo: string, requestId: string, version: number, value?: string): Promise<void> {
		const worker = this.#requireWorker(repo);
		const pending = worker.pending.get(requestId);
		if (!pending) throw new Error(`No pending UI request ${requestId} for ${repo}`);
		if (pending.version !== version) {
			throw new Error(`Pending UI request ${requestId} for ${repo} is no longer the observed request`);
		}
		let response: RpcExtensionUiResponse;
		if (pending.responseMethod === "confirm") response = { id: requestId, confirmed: true };
		else {
			if (value === undefined) throw new Error(`${pending.responseMethod} approval requires a value`);
			response = { id: requestId, value };
		}
		await this.#activeClient(repo).respondToExtensionUi(response);
		if (worker.pending.get(requestId)?.version === version) worker.pending.delete(requestId);
		this.#emit("ui_response", repo, { id: requestId, approved: true });
	}

	async deny(repo: string, requestId: string, version: number): Promise<void> {
		const worker = this.#requireWorker(repo);
		const pending = worker.pending.get(requestId);
		if (!pending) throw new Error(`No pending UI request ${requestId} for ${repo}`);
		if (pending.version !== version) {
			throw new Error(`Pending UI request ${requestId} for ${repo} is no longer the observed request`);
		}
		const response: RpcExtensionUiResponse =
			pending.responseMethod === "confirm"
				? { id: requestId, confirmed: false }
				: { id: requestId, cancelled: true };
		await this.#activeClient(repo).respondToExtensionUi(response);
		if (worker.pending.get(requestId)?.version === version) worker.pending.delete(requestId);
		this.#emit("ui_response", repo, { id: requestId, approved: false });
	}

	closeAll(): Promise<void> {
		if (!this.#closePromise) this.#closePromise = this.#performCloseAll();
		return this.#closePromise;
	}

	async #performCloseAll(): Promise<void> {
		if (this.#closed) return;
		this.#closing = true;
		this.#closeStarted.resolve();
		if (!this.#startPromise) this.#startPromise = this.#run();
		await Promise.allSettled(
			[...this.#workers.values()].map(async worker => {
				if (!worker.client || worker.closed) return;
				worker.abortRequested = true;
				if (!worker.abortOutcome) {
					try {
						void worker.client.abort().catch(() => {
							// Closing the transport below is the fallback cancellation path.
						});
					} catch {
						// A synchronous abort failure must not prevent transport closure.
					}
				}
				await this.#closeWorker(worker);
			}),
		);
		await this.#startPromise;
		this.#closed = true;
		this.#emit("run_closed", undefined, {});
		await this.#persistenceTail;
	}

	async #run(): Promise<FleetSnapshot> {
		await this.#fileSystem.mkdir(this.runDirectory, { recursive: true });
		await this.#writeAtomic("snapshot.json", this.#persistedSnapshot());
		await this.#writeAtomic("results.json", this.#persistedResults());
		this.#startedAt = this.#now();
		this.#emit("run_started", undefined, { repositories: [...this.#workers.keys()] });

		const workers = [...this.#workers.values()];
		const concurrency = Math.min(this.config.maxConcurrency ?? 4, workers.length);
		let nextIndex = 0;
		const runners = Array.from({ length: concurrency }, async () => {
			while (!this.#closing) {
				const index = nextIndex++;
				if (index >= workers.length) return;
				const worker = workers[index];
				if (worker.abortRequested || worker.state === "aborted") continue;
				await this.#runWorker(worker);
			}
		});
		await Promise.all(runners);
		for (const worker of workers) {
			if (worker.state === "pending") {
				worker.state = "aborted";
				worker.closed = true;
				this.#emit("worker_state", worker.repo, { state: worker.state });
			}
		}
		this.#finishedAt = this.#now();
		this.#closed = workers.every(worker => worker.closed);
		this.#emit("run_finished", undefined, {
			succeeded: workers.filter(worker => worker.state === "succeeded").length,
			failed: workers.filter(worker => worker.state === "failed").length,
			aborted: workers.filter(worker => worker.state === "aborted").length,
		});
		await this.#persistenceTail;
		return this.getSnapshot();
	}

	async #runWorker(worker: WorkerRuntime): Promise<void> {
		if (worker.abortRequested || worker.state === "aborted") return;
		worker.state = "starting";
		this.#emit("worker_state", worker.repo, { state: worker.state });
		try {
			const directory = await this.#fileSystem.stat(worker.config.cwd);
			if (worker.abortRequested || this.#closing) {
				worker.abortRequested = true;
				if (worker.state !== "aborted") {
					worker.state = "aborted";
					this.#emit("worker_state", worker.repo, { state: worker.state });
				}
				return;
			}
			if (!directory.isDirectory()) throw new Error(`fleet repository ${worker.repo} cwd is not a directory`);
			const envContext: FleetWorkerEnvContext = {
				repo: worker.repo,
				cwd: worker.config.cwd,
				runId: this.runId,
			};
			const client = await this.#clientFactory({
				...envContext,
				env: this.#envPolicy(envContext),
			});
			worker.client = client;
			if (worker.abortRequested || this.#closing) {
				worker.abortRequested = true;
				worker.state = "aborted";
				this.#emit("worker_state", worker.repo, { state: worker.state });
				return;
			}
			worker.frameListener = frame => this.#handleFrame(worker, frame);
			client.on("frame", worker.frameListener);
			await client.start();
			if (worker.abortRequested || this.#closing) {
				worker.abortRequested = true;
				worker.state = "aborted";
				this.#emit("worker_state", worker.repo, { state: worker.state });
				return;
			}
			worker.state = "running";
			this.#emit("worker_state", worker.repo, { state: worker.state });
			await client.prompt(composeFleetPrompt(this.config, worker.repo));
			await this.#settleAbortOutcome(worker);
			if (worker.abortRequested || this.#closing) {
				worker.state = "aborted";
				this.#emit("worker_state", worker.repo, { state: worker.state });
				return;
			}
			const response = await client.request({ type: "get_last_assistant_text" }, "result");
			await this.#settleAbortOutcome(worker);
			if (worker.abortRequested || this.#closing) {
				worker.state = "aborted";
				this.#emit("worker_state", worker.repo, { state: worker.state });
				return;
			}
			worker.result = { repo: worker.repo, text: assistantText(response), completedAt: this.#now() };
			worker.state = "succeeded";
			this.#emit("result", worker.repo, { result: worker.result });
			this.#emit("worker_state", worker.repo, { state: worker.state });
		} catch (error) {
			await this.#settleAbortOutcome(worker);
			worker.error = errorMessage(error);
			worker.state = worker.abortRequested || this.#closing ? "aborted" : "failed";
			this.#emit("worker_state", worker.repo, { state: worker.state, error: worker.error });
		} finally {
			await this.#closeWorker(worker);
		}
	}

	async #settleAbortOutcome(worker: WorkerRuntime): Promise<void> {
		const outcome = worker.abortOutcome;
		if (!outcome || this.#closing) return;
		await Promise.race([
			outcome.then(
				() => undefined,
				() => undefined,
			),
			this.#closeStarted.promise,
		]);
	}

	#rejectUnsafeUiRequest(worker: WorkerRuntime, id: string, method: string): void {
		const response: RpcExtensionUiResponse =
			method === "confirm"
				? { id, confirmed: false }
				: { id, cancelled: true };
		try {
			const rejection = worker.client?.respondToExtensionUi(response);
			void rejection?.catch(() => {
				this.#emit("warning", worker.repo, { message: "Failed to reject an unsafe UI request identifier" });
			});
		} catch {
			this.#emit("warning", worker.repo, { message: "Failed to reject an unsafe UI request identifier" });
		}
	}

	#handleFrame(worker: WorkerRuntime, frame: RpcObject): void {
		if (
			frame.type === "extension_ui_request" &&
			typeof frame.id === "string" &&
			typeof frame.method === "string" &&
			INTERACTIVE_UI_METHODS[frame.method] &&
			!INTERACTIVE_UI_REQUEST_ID.test(frame.id)
		) {
			this.#rejectUnsafeUiRequest(worker, frame.id, frame.method);
			return;
		}
		worker.lastFrame = summarizeRpcFrame(frame);
		this.#emit("worker_frame", worker.repo, { frame: worker.lastFrame });
		if (
			frame.type === "extension_ui_request" &&
			frame.method === "cancel" &&
			typeof frame.targetId === "string"
		) {
			if (worker.pending.delete(frame.targetId)) {
				this.#emit("ui_response", worker.repo, {
					id: frame.targetId,
					approved: false,
					cancelled: true,
				});
			}
			return;
		}
		if (
			frame.type !== "extension_ui_request" ||
			typeof frame.id !== "string" ||
			typeof frame.method !== "string" ||
			!INTERACTIVE_UI_METHODS[frame.method]
		) {
			return;
		}
		const pending: FleetPendingUiRequest & { responseMethod: string } = {
			repo: worker.repo,
			id: frame.id,
			version: ++worker.nextPendingVersion,
			method: frame.method,
			responseMethod: frame.method,
			...(typeof frame.title === "string" ? { title: frame.title } : {}),
			...(typeof frame.message === "string" ? { message: frame.message } : {}),
			...(typeof frame.placeholder === "string" ? { placeholder: frame.placeholder } : {}),
			...(typeof frame.prefill === "string" ? { prefill: frame.prefill } : {}),
			...(Array.isArray(frame.options) ? { options: [...frame.options] } : {}),
		};
		worker.pending.set(frame.id, pending);
		const { responseMethod: _responseMethod, ...request } = pending;
		this.#emit("ui_request", worker.repo, { request });
	}

	#requireWorker(repo: string): WorkerRuntime {
		const worker = this.#workers.get(repo);
		if (!worker) throw new Error(`Unknown or disabled fleet repository: ${repo}`);
		return worker;
	}

	#activeClient(repo: string): FleetRpcClient {
		const worker = this.#requireWorker(repo);
		if (worker.state !== "running" || !worker.client || worker.closed) {
			throw new Error(`Fleet repository ${repo} is not running`);
		}
		return worker.client;
	}

	async #closeWorker(worker: WorkerRuntime): Promise<void> {
		if (!worker.client || worker.closed) {
			worker.closed = true;
			return;
		}
		worker.closed = true;
		worker.pending.clear();
		if (worker.frameListener) worker.client.off?.("frame", worker.frameListener);
		try {
			await worker.client.close();
		} catch (error) {
			this.#emit("warning", worker.repo, { message: `RPC close failed: ${errorMessage(error)}` });
		}
	}

	#emit(type: FleetEvent["type"], repo: string | undefined, data: Record<string, unknown>): void {
		const event: FleetEvent = {
			sequence: ++this.#sequence,
			time: this.#now(),
			runId: this.runId,
			type,
			...(repo === undefined ? {} : { repo }),
			...(Object.keys(data).length === 0 ? {} : { data: structuredClone(data) }),
		};
		const persistedLine = `${JSON.stringify(this.#persistableEvent(event))}\n`;
		for (const listener of this.#listeners) {
			try {
				listener(structuredClone(event));
			} catch {
				// Observers are isolated from worker and persistence lifecycles.
			}
		}
		this.#persistenceTail = this.#persistenceTail
			.then(async () => {
				await this.#fileSystem.appendFile(resolve(this.runDirectory, "events.jsonl"), persistedLine, "utf8");
				if (type !== "worker_frame") {
					await this.#writeAtomic("snapshot.json", this.#persistedSnapshot());
				}
				if (type === "result" || type === "run_finished" || type === "run_closed") {
					await this.#writeAtomic("results.json", this.#persistedResults());
				}
			})
			.catch(error => {
				this.#persistenceError = `Fleet persistence failed: ${errorMessage(error)}`;
				const warning: FleetEvent = {
					sequence: ++this.#sequence,
					time: this.#now(),
					runId: this.runId,
					type: "warning",
					...(repo === undefined ? {} : { repo }),
					data: { message: this.#persistenceError },
				};
				for (const listener of this.#listeners) {
					try {
						listener(structuredClone(warning));
					} catch {
						// Observers are isolated from persistence failure reporting.
					}
				}
			});
	}

	#persistableEvent(event: FleetEvent): FleetEvent {
		const data = event.data;
		switch (event.type) {
			case "run_started":
				return { ...event, ...(data ? { data: { repositories: data.repositories } } : {}) };
			case "worker_state":
				return { ...event, ...(data ? { data: { state: data.state } } : {}) };
			case "worker_frame":
				return { ...event, ...(data ? { data: { frame: data.frame } } : {}) };
			case "ui_request": {
				const request = data?.request;
				if (typeof request !== "object" || request === null) return { ...event, data: {} };
				const value = request as Record<string, unknown>;
				return {
					...event,
					data: { request: { id: value.id, method: value.method, repo: value.repo } },
				};
			}
			case "ui_response":
				return {
					...event,
					...(data
						? { data: { id: data.id, approved: data.approved, cancelled: data.cancelled } }
						: {}),
				};
			case "result": {
				const result = data?.result;
				const value = typeof result === "object" && result !== null ? result as Record<string, unknown> : {};
				return { ...event, data: { completedAt: value.completedAt } };
			}
			case "run_finished":
				return {
					...event,
					...(data
						? { data: { succeeded: data.succeeded, failed: data.failed, aborted: data.aborted } }
						: {}),
				};
			case "warning":
			case "run_closed":
				return { sequence: event.sequence, time: event.time, runId: event.runId, type: event.type, ...(event.repo ? { repo: event.repo } : {}) };
		}
	}

	#persistedSnapshot(): FleetPersistedSnapshot {
		const snapshot = this.getSnapshot();
		return {
			runId: snapshot.runId,
			name: snapshot.name,
			window: snapshot.window,
			maxConcurrency: snapshot.maxConcurrency,
			createdAt: snapshot.createdAt,
			...(snapshot.startedAt ? { startedAt: snapshot.startedAt } : {}),
			...(snapshot.finishedAt ? { finishedAt: snapshot.finishedAt } : {}),
			closed: snapshot.closed,
			workers: snapshot.workers.map(worker => ({
				repo: worker.repo,
				state: worker.state,
				closed: worker.closed,
				...(worker.lastFrame ? { lastFrame: worker.lastFrame } : {}),
				pendingRequests: worker.pendingRequests.map(request => ({
					repo: request.repo,
					id: request.id,
					method: request.method,
				})),
			})),
		};
	}

	#persistedResults(): Record<string, FleetPersistedResultSummary> {
		const summaries = new Map<string, FleetPersistedResultSummary>();
		for (const worker of this.#workers.values()) {
			if (!worker.result) continue;
			summaries.set(worker.repo, {
				repo: worker.repo,
				state: "succeeded",
				completedAt: worker.result.completedAt,
			});
		}
		return Object.fromEntries(summaries);
	}

	async #writeAtomic(fileName: string, value: unknown): Promise<void> {
		const destination = resolve(this.runDirectory, fileName);
		const temporary = `${destination}.${this.runId}.${++this.#atomicSequence}.tmp`;
		await this.#fileSystem.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await this.#fileSystem.rename(temporary, destination);
	}

	#now(): string {
		const value = this.#clock();
		return value instanceof Date ? value.toISOString() : value;
	}
}
