import { expect, test } from "bun:test";
import {
	defaultFleetWorkerEnv,
	OmpFleetRun,
	type FleetEvent,
	type FleetFileSystem,
	type FleetRpcClient,
} from "../src/omp-fleet.ts";
import type {
	RpcExtensionUiResponse,
	RpcObject,
	RpcPromptResult,
	RpcReadyFrame,
	RpcResponseFrame,
} from "../src/omp-rpc-client.ts";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
	settled: boolean;
}

function deferred<T>(): Deferred<T> {
	let resolvePromise!: (value: T) => void;
	let rejectPromise!: (error: Error) => void;
	const result: Deferred<T> = {
		promise: new Promise<T>((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		}),
		resolve(value) {
			result.settled = true;
			resolvePromise(value);
		},
		reject(error) {
			result.settled = true;
			rejectPromise(error);
		},
		settled: false,
	};
	return result;
}

class FakeClient implements FleetRpcClient {
	readonly promptCompletion = deferred<RpcPromptResult>();
	readonly promptStarted = deferred<void>();
	readonly startStarted = deferred<void>();
	readonly prompts: string[] = [];
	readonly steers: string[] = [];
	readonly followUps: string[] = [];
	readonly uiResponses: RpcExtensionUiResponse[] = [];
	readonly listeners = new Set<(frame: RpcObject) => void>();
	closeCount = 0;
	abortCount = 0;
	startError?: Error;
	abortCompletion?: Deferred<RpcResponseFrame>;
	onAbort?: () => void;
	readonly requestStarted = deferred<void>();
	startCount = 0;
	requestCount = 0;
	startCompletion?: Deferred<RpcReadyFrame>;
	resultRequestCompletion?: Deferred<RpcResponseFrame>;

	constructor(readonly resultText: string | null) {}

	async start(): Promise<RpcReadyFrame> {
		if (!this.startStarted.settled) this.startStarted.resolve();
		this.startCount++;
		if (this.startError) throw this.startError;
		return this.startCompletion?.promise ?? { type: "ready", protocolVersion: 1 };
	}

	prompt(message: string): Promise<RpcPromptResult> {
		if (!this.promptStarted.settled) this.promptStarted.resolve();
		this.prompts.push(message);
		return this.promptCompletion.promise;
	}

	async request(command: RpcObject): Promise<RpcResponseFrame> {
		expect(command).toEqual({ type: "get_last_assistant_text" });
		this.requestCount++;
		if (!this.requestStarted.settled) this.requestStarted.resolve();
		return this.resultRequestCompletion?.promise ?? {
			type: "response",
			command: "get_last_assistant_text",
			success: true,
			data: { text: this.resultText },
		};
	}

	async steer(message: string): Promise<RpcResponseFrame> {
		this.steers.push(message);
		return { type: "response", command: "steer", success: true };
	}

	async followUp(message: string): Promise<RpcResponseFrame> {
		this.followUps.push(message);
		return { type: "response", command: "follow_up", success: true };
	}

	async abort(): Promise<RpcResponseFrame> {
		const completion = this.abortCompletion;
		this.abortCount++;
		this.onAbort?.();
		return completion?.promise ?? { type: "response", command: "abort", success: true };
	}

	async respondToExtensionUi(response: RpcExtensionUiResponse): Promise<void> {
		this.uiResponses.push(response);
	}

	async close(): Promise<void> {
		this.closeCount++;
		if (!this.promptCompletion.settled && this.prompts.length > 0) {
			this.promptCompletion.reject(new Error("transport closed"));
		}
	}

	on(_event: "frame", listener: (frame: RpcObject) => void): void {
		this.listeners.add(listener);
	}

	off(_event: "frame", listener: (frame: RpcObject) => void): void {
		this.listeners.delete(listener);
	}

	emit(frame: RpcObject): void {
		for (const listener of this.listeners) listener(frame);
	}

	complete(): void {
		this.promptCompletion.resolve({
			id: "prompt",
			acknowledgement: { type: "response", command: "prompt", success: true },
			completion: { type: "agent_end", isTerminal: true },
			frames: [],
		});
	}
}

class MemoryFileSystem implements FleetFileSystem {
	readonly files = new Map<string, string>();
	readonly directories: string[] = [];
	readonly renames: Array<[string, string]> = [];
	readonly nonDirectories = new Set<string>();
	readonly operations: Array<{ kind: "append" | "write"; path: string; data: string }> = [];
	appendAttempts = 0;
	failNextAppend = false;

	async mkdir(path: string): Promise<void> {
		this.directories.push(path);
	}

	async stat(path: string): Promise<{ isDirectory(): boolean }> {
		return { isDirectory: () => !this.nonDirectories.has(path) };
	}

	async appendFile(path: string, data: string): Promise<void> {
		this.appendAttempts++;
		this.operations.push({ kind: "append", path, data });
		if (this.failNextAppend) {
			this.failNextAppend = false;
			throw new Error("simulated append failure");
		}
		this.files.set(path, (this.files.get(path) ?? "") + data);
	}

	async writeFile(path: string, data: string): Promise<void> {
		this.operations.push({ kind: "write", path, data });
		this.files.set(path, data);
	}

	async rename(from: string, to: string): Promise<void> {
		const value = this.files.get(from);
		if (value === undefined) throw new Error(`missing temporary file ${from}`);
		this.files.delete(from);
		this.files.set(to, value);
		this.renames.push([from, to]);
	}

	fileEnding(suffix: string): string {
		const entry = [...this.files].find(([path]) => path.endsWith(suffix));
		if (!entry) throw new Error(`missing ${suffix}`);
		return entry[1];
	}
}

function testConfig(maxConcurrency = 2) {
	return {
		name: "test fleet",
		goal: "Common goal",
		window: "none" as const,
		maxConcurrency,
		repos: {
			a: { cwd: "C:/repos/a", message: "A only" },
			b: { cwd: "C:/repos/b", message: "B only" },
			c: { cwd: "C:/repos/c", message: "C only" },
		},
	};
}

test("bounds active workers, composes prompts, and attributes out-of-order results", async () => {
	const fs = new MemoryFileSystem();
	const clients = {
		a: new FakeClient("result a"),
		b: new FakeClient("result b"),
		c: new FakeClient("result c"),
	};
	const created: string[] = [];
	const resultOrder: string[] = [];
	const fleet = new OmpFleetRun(testConfig(), {
		fileSystem: fs,
		runRoot: "C:/runs",
		idSource: () => "run-order",
		clock: () => "2026-08-08T00:00:00.000Z",
		clientFactory: ({ repo, cwd }) => {
			expect(cwd).toBe(`C:/repos/${repo}`);
			created.push(repo);
			return clients[repo as keyof typeof clients];
		},
	});
	fleet.subscribe(event => {
		if (event.type === "result" && event.repo) resultOrder.push(event.repo);
	});
	const finished = fleet.start();
	await Promise.all([clients.a.promptStarted.promise, clients.b.promptStarted.promise]);
	expect(created).toEqual(["a", "b"]);
	expect(clients.a.prompts).toEqual(["Common goal\n\nRepository-specific instructions:\nA only"]);
	expect(clients.b.prompts).toEqual(["Common goal\n\nRepository-specific instructions:\nB only"]);

	clients.b.complete();
	await clients.c.promptStarted.promise;
	expect(created).toEqual(["a", "b", "c"]);
	clients.c.complete();
	clients.a.complete();
	const snapshot = await finished;

	expect(resultOrder).toEqual(["b", "c", "a"]);
	expect(snapshot.workers.map(worker => [worker.repo, worker.state])).toEqual([
		["a", "succeeded"],
		["b", "succeeded"],
		["c", "succeeded"],
	]);
	expect(Object.keys(fleet.getResults())).toEqual(["a", "b", "c"]);
	expect(Object.values(clients).map(client => client.closeCount)).toEqual([1, 1, 1]);
});

test("routes targeting and keeps UI requests pending until explicit approval or denial", async () => {
	const client = new FakeClient("unused");
	const fleet = new OmpFleetRun(
		{
			name: "targeting",
			goal: "Work",
			window: "none",
			repos: { api: { cwd: "C:/api" } },
		},
		{
			fileSystem: new MemoryFileSystem(),
			runRoot: "C:/runs",
			idSource: () => "run-target",
			clock: () => "2026-08-08T00:00:00.000Z",
			clientFactory: () => client,
		},
	);
	const finished = fleet.start();
	await client.promptStarted.promise;
	client.emit({
		type: "extension_ui_request",
		id: "confirm-1",
		method: "confirm",
		title: "Deploy",
		message: "Proceed?",
	});
	client.emit({ type: "extension_ui_request", id: "input-1", method: "input", placeholder: "branch" });
	const initialPending = fleet.getSnapshot().workers[0].pendingRequests;
	expect(initialPending.map(request => request.id)).toEqual(["confirm-1", "input-1"]);
	expect(initialPending.map(request => request.version)).toEqual([1, 2]);
	client.emit({ type: "extension_ui_request", id: "cancel-me", method: "editor", message: "secret draft" });
	client.emit({ type: "extension_ui_request", method: "cancel", targetId: "cancel-me" });
	expect(fleet.getPendingRequest("api", "cancel-me")).toBeUndefined();
	expect(fleet.getSnapshot().workers[0].pendingRequests.map(request => request.id)).toEqual(["confirm-1", "input-1"]);


	await fleet.steer("api", "change course");
	await fleet.followUp("api", "summarize later");
	expect(client.steers).toEqual(["change course"]);
	expect(client.followUps).toEqual(["summarize later"]);
	const confirm = fleet.getPendingRequest("api", "confirm-1");
	expect(confirm).toBeDefined();
	await fleet.approve("api", "confirm-1", confirm!.version);
	expect(client.uiResponses.at(-1)).toEqual({ id: "confirm-1", confirmed: true });
	const input = fleet.getPendingRequest("api", "input-1");
	expect(input).toBeDefined();
	await expect(fleet.approve("api", "input-1", input!.version)).rejects.toThrow("requires a value");
	expect(fleet.getPendingRequest("api", "input-1")?.placeholder).toBe("branch");
	await fleet.approve("api", "input-1", input!.version, "feature/fleet");
	expect(client.uiResponses.at(-1)).toEqual({ id: "input-1", value: "feature/fleet" });
	client.emit({ type: "extension_ui_request", id: "confirm-2", method: "confirm" });
	const denied = fleet.getPendingRequest("api", "confirm-2");
	expect(denied).toBeDefined();
	await fleet.deny("api", "confirm-2", denied!.version);
	expect(client.uiResponses.at(-1)).toEqual({ id: "confirm-2", confirmed: false });

	await fleet.abort("api");
	client.complete();
	const snapshot = await finished;
	expect(snapshot.workers[0].state).toBe("aborted");
	expect(client.abortCount).toBe(1);
	expect(client.closeCount).toBe(1);
});

test("rejects approval identities cancelled and replaced under the same wire id", async () => {
	const client = new FakeClient("unused");
	const fleet = new OmpFleetRun(
		{
			name: "approval-identity",
			goal: "Work",
			window: "none",
			repos: { api: { cwd: "C:/api" } },
		},
		{
			fileSystem: new MemoryFileSystem(),
			runRoot: "C:/runs",
			idSource: () => "run-approval-identity",
			clientFactory: () => client,
		},
	);
	const finished = fleet.start();
	await client.promptStarted.promise;

	client.emit({ type: "extension_ui_request", id: "same-confirm", method: "confirm", title: "First" });
	const firstConfirm = fleet.getPendingRequest("api", "same-confirm");
	expect(firstConfirm).toBeDefined();
	client.emit({ type: "extension_ui_request", method: "cancel", targetId: "same-confirm" });
	client.emit({ type: "extension_ui_request", id: "same-confirm", method: "confirm", title: "Replacement" });
	const replacementConfirm = fleet.getPendingRequest("api", "same-confirm");
	expect(replacementConfirm).toBeDefined();
	expect(replacementConfirm!.version).toBeGreaterThan(firstConfirm!.version);
	await expect(
		fleet.approve("api", "same-confirm", firstConfirm!.version),
	).rejects.toThrow("no longer the observed request");
	expect(client.uiResponses).toEqual([]);
	expect(fleet.getPendingRequest("api", "same-confirm")?.title).toBe("Replacement");
	await fleet.approve("api", "same-confirm", replacementConfirm!.version);

	client.emit({
		type: "extension_ui_request",
		id: "same-select",
		method: "select",
		options: ["first"],
	});
	const firstSelect = fleet.getPendingRequest("api", "same-select");
	expect(firstSelect).toBeDefined();
	client.emit({ type: "extension_ui_request", method: "cancel", targetId: "same-select" });
	client.emit({
		type: "extension_ui_request",
		id: "same-select",
		method: "select",
		options: ["replacement"],
	});
	const replacementSelect = fleet.getPendingRequest("api", "same-select");
	expect(replacementSelect).toBeDefined();
	expect(replacementSelect!.version).toBeGreaterThan(firstSelect!.version);
	await expect(
		fleet.deny("api", "same-select", firstSelect!.version),
	).rejects.toThrow("no longer the observed request");
	expect(fleet.getPendingRequest("api", "same-select")?.options).toEqual(["replacement"]);
	await fleet.deny("api", "same-select", replacementSelect!.version);
	expect(client.uiResponses).toEqual([
		{ id: "same-confirm", confirmed: true },
		{ id: "same-select", cancelled: true },
	]);

	await fleet.abort("api");
	client.complete();
	await finished;
});

test("rejects nonconforming UI ids without registering or publishing them", async () => {
	const client = new FakeClient("unused");
	const fleet = new OmpFleetRun(
		{
			name: "unsafe-ui-id",
			goal: "Work",
			window: "none",
			repos: { api: { cwd: "C:/api" } },
		},
		{
			fileSystem: new MemoryFileSystem(),
			runRoot: "C:/runs",
			idSource: () => "run-unsafe-ui-id",
			clientFactory: () => client,
		},
	);
	const events: FleetEvent[] = [];
	fleet.subscribe(event => events.push(event));
	const finished = fleet.start();
	await client.promptStarted.promise;

	const unsafeConfirmId = "confirm\nunsafe";
	const unsafeSelectId = "select\u001bunsafe";
	const unicodeSeparatorId = "confirm\u2028unsafe";
	const spacedId = "input unsafe";
	const overlengthId = "x".repeat(129);
	client.emit({ type: "extension_ui_request", id: unsafeConfirmId, method: "confirm" });
	client.emit({ type: "extension_ui_request", id: unsafeSelectId, method: "select", options: ["one"] });
	client.emit({ type: "extension_ui_request", id: unicodeSeparatorId, method: "confirm" });
	client.emit({ type: "extension_ui_request", id: spacedId, method: "input" });
	client.emit({ type: "extension_ui_request", id: overlengthId, method: "editor" });

	expect(client.uiResponses).toEqual([
		{ id: unsafeConfirmId, confirmed: false },
		{ id: unsafeSelectId, cancelled: true },
		{ id: unicodeSeparatorId, confirmed: false },
		{ id: spacedId, cancelled: true },
		{ id: overlengthId, cancelled: true },
	]);
	expect(fleet.getSnapshot().workers[0].pendingRequests).toEqual([]);
	expect(events.some(event => event.type === "ui_request" || event.type === "worker_frame")).toBe(false);
	expect(fleet.getSnapshot().workers[0].lastFrame).toBeUndefined();

	const safeId = "Az09._:-";
	client.emit({ type: "extension_ui_request", id: safeId, method: "confirm" });
	const safeRequest = fleet.getPendingRequest("api", safeId);
	expect(safeRequest).toBeDefined();
	await fleet.approve("api", safeId, safeRequest!.version);
	expect(client.uiResponses.at(-1)).toEqual({ id: safeId, confirmed: true });

	await fleet.abort("api");
	client.complete();
	await finished;
});

test("isolates worker failures and persists sanitized atomic snapshots, events, and results", async () => {
	const fs = new MemoryFileSystem();
	const failed = new FakeClient(null);
	failed.startError = new Error("cannot start");
	const successful = new FakeClient("safe result");
	const config = {
		name: "persistence",
		goal: "private prompt should not persist",
		window: "none" as const,
		repos: {
			bad: { cwd: "C:/bad", message: "private bad instructions" },
			good: { cwd: "C:/good", message: "private good instructions" },
		},
	};
	const fleet = new OmpFleetRun(config, {
		fileSystem: fs,
		runRoot: "C:/fleet-root",
		idSource: () => "run-persist",
		clock: () => "2026-08-08T00:00:00.000Z",
		clientFactory: ({ repo }) => (repo === "bad" ? failed : successful),
	});
	const finished = fleet.start();
	await successful.promptStarted.promise;
	successful.emit({
		type: "extension_ui_request",
		id: "secret-ui",
		method: "confirm",
		title: "Private title",
		message: "Private message",
		environment: { TOKEN: "no" },
	});
	successful.emit({
		type: "extension_ui_request",
		id: "secret-editor",
		method: "editor",
		prefill: "Private editor prefill",
	});
	expect(fleet.getPendingRequest("good", "secret-editor")?.prefill).toBe("Private editor prefill");
	successful.complete();
	const snapshot = await finished;

	expect(snapshot.workers.map(worker => worker.state)).toEqual(["failed", "succeeded"]);
	expect(failed.closeCount).toBe(1);
	expect(successful.closeCount).toBe(1);
	const persisted = [
		fs.fileEnding("snapshot.json"),
		fs.fileEnding("results.json"),
		fs.fileEnding("events.jsonl"),
	].join("\n");
	expect(persisted).not.toContain("safe result");
	expect(persisted).not.toContain("cannot start");
	expect(persisted).not.toContain("private prompt");
	expect(persisted).not.toContain("private good instructions");
	expect(persisted).not.toContain("Private title");
	expect(persisted).not.toContain("Private message");
	expect(persisted).not.toContain("TOKEN");
	expect(persisted).not.toContain("Private editor prefill");
	expect(fleet.getResults().good?.text).toBe("safe result");
	expect(snapshot.workers.find(worker => worker.repo === "bad")?.error).toBe("cannot start");
	expect([...fs.files.keys()].some(path => path.endsWith(".tmp"))).toBe(false);
	expect(fs.renames.some(([, to]) => to.endsWith("snapshot.json"))).toBe(true);
	expect(fs.renames.some(([, to]) => to.endsWith("results.json"))).toBe(true);
});

test("appends streamed RPC frames without rewriting the atomic snapshot for each delta", async () => {
	const fs = new MemoryFileSystem();
	const client = new FakeClient("done");
	const fleet = new OmpFleetRun(
		{ name: "stream persistence", goal: "Work", window: "none", repos: { api: { cwd: "C:/api" } } },
		{
			fileSystem: fs,
			runRoot: "C:/runs",
			idSource: () => "run-stream-persistence",
			clientFactory: () => client,
		},
	);
	const finished = fleet.start();
	await client.promptStarted.promise;
	client.emit({ type: "message_update", id: "delta-1" });
	client.emit({ type: "message_update", id: "delta-2" });
	client.complete();
	await finished;

	const frameAppendIndexes = fs.operations.flatMap((operation, index) =>
		operation.kind === "append" && operation.data.includes('"type":"worker_frame"') ? [index] : [],
	);
	expect(frameAppendIndexes).toHaveLength(2);
	for (const index of frameAppendIndexes) expect(fs.operations[index + 1]?.kind).toBe("append");
	expect(fs.fileEnding("events.jsonl").match(/"type":"worker_frame"/gu)).toHaveLength(2);
});

test("recovers the persistence queue after an I/O rejection and reports it only in memory", async () => {
	const fs = new MemoryFileSystem();
	fs.failNextAppend = true;
	const client = new FakeClient("done");
	const warnings: FleetEvent[] = [];
	const fleet = new OmpFleetRun(
		{ name: "persistence recovery", goal: "Work", window: "none", repos: { api: { cwd: "C:/api" } } },
		{
			fileSystem: fs,
			runRoot: "C:/runs",
			idSource: () => "run-persistence-recovery",
			clientFactory: () => client,
		},
	);
	fleet.subscribe(event => {
		if (event.type === "warning") warnings.push(event);
	});
	const finished = fleet.start();
	await client.promptStarted.promise;
	client.complete();
	const snapshot = await finished;

	expect(snapshot.persistenceError).toContain("simulated append failure");
	expect(warnings.at(-1)?.data?.message).toBe(snapshot.persistenceError);
	expect(fs.appendAttempts).toBeGreaterThan(1);
	const persistedEvents = fs.fileEnding("events.jsonl");
	expect(persistedEvents).toContain('"type":"run_finished"');
	expect(persistedEvents).not.toContain('"type":"warning"');
});

test("targeted cancellation skips a pending worker without creating or prompting its client", async () => {
	const clients = { a: new FakeClient("a"), b: new FakeClient("b"), c: new FakeClient("c") };
	const created: string[] = [];
	const fleet = new OmpFleetRun(testConfig(1), {
		fileSystem: new MemoryFileSystem(),
		runRoot: "C:/runs",
		idSource: () => "run-cancel-pending",
		clientFactory: ({ repo }) => {
			created.push(repo);
			return clients[repo as keyof typeof clients];
		},
	});
	const finished = fleet.start();
	await clients.a.promptStarted.promise;
	await fleet.abort("b");
	expect(fleet.getSnapshot().workers.find(worker => worker.repo === "b")).toMatchObject({
		state: "aborted",
		closed: true,
	});
	clients.a.complete();
	await clients.c.promptStarted.promise;
	clients.c.complete();
	const snapshot = await finished;

	expect(created).toEqual(["a", "c"]);
	expect(clients.b.startCount).toBe(0);
	expect(clients.b.prompts).toEqual([]);
	expect(snapshot.workers.find(worker => worker.repo === "b")).toMatchObject({ state: "aborted", closed: true });
});

test("targeted cancellation closes a starting transport and never prompts it", async () => {
	const client = new FakeClient(null);
	client.startCompletion = deferred<RpcReadyFrame>();
	const fleet = new OmpFleetRun(
		{ name: "cancel starting", goal: "Work", window: "none", repos: { api: { cwd: "C:/api" } } },
		{
			fileSystem: new MemoryFileSystem(),
			runRoot: "C:/runs",
			idSource: () => "run-cancel-starting",
			clientFactory: () => client,
		},
	);
	const finished = fleet.start();
	await client.startStarted.promise;
	await fleet.abort("api");
	expect(client.closeCount).toBe(1);
	client.startCompletion.resolve({ type: "ready", protocolVersion: 1 });
	const snapshot = await finished;

	expect(client.abortCount).toBe(0);
	expect(client.prompts).toEqual([]);
	expect(snapshot.workers[0]).toMatchObject({ state: "aborted", closed: true });
});

test("closeAll ignores stalled abort acknowledgements and serializes concurrent cleanup", async () => {
	const clients = { a: new FakeClient(null), b: new FakeClient(null), c: new FakeClient(null) };
	for (const client of Object.values(clients)) client.abortCompletion = deferred<RpcResponseFrame>();
	const terminalEvents: FleetEvent["type"][] = [];
	const fleet = new OmpFleetRun(testConfig(3), {
		fileSystem: new MemoryFileSystem(),
		runRoot: "C:/runs",
		idSource: () => "run-close",
		clock: () => "2026-08-08T00:00:00.000Z",
		clientFactory: ({ repo }) => clients[repo as keyof typeof clients],
	});
	fleet.subscribe(event => {
		if (event.type === "run_finished" || event.type === "run_closed") terminalEvents.push(event.type);
	});
	void fleet.start();
	await Promise.all(Object.values(clients).map(client => client.promptStarted.promise));
	const firstClose = fleet.closeAll();
	const secondClose = fleet.closeAll();
	expect(secondClose).toBe(firstClose);
	await Promise.all([firstClose, secondClose, fleet.closeAll()]);
	expect(Object.values(clients).map(client => [client.abortCount, client.closeCount])).toEqual([
		[1, 1],
		[1, 1],
		[1, 1],
	]);
	expect(terminalEvents).toEqual(["run_finished", "run_closed"]);
	expect(fleet.getSnapshot().workers.every(worker => worker.state === "aborted" && worker.closed)).toBe(true);
});

test("closeAll does not wait for or duplicate a stalled targeted abort", async () => {
	const client = new FakeClient(null);
	client.abortCompletion = deferred<RpcResponseFrame>();
	const fleet = new OmpFleetRun(testConfig(1), {
		fileSystem: new MemoryFileSystem(),
		runRoot: "C:/runs",
		idSource: () => "run-close-targeted-abort",
		clientFactory: () => client,
	});
	const finished = fleet.start();
	await client.promptStarted.promise;
	void fleet.abort("a");
	client.complete();
	await fleet.closeAll();
	const snapshot = await finished;
	expect(client.abortCount).toBe(1);
	expect(client.closeCount).toBe(1);
	expect(snapshot.workers[0].state).toBe("aborted");
});

test("closes a client whose factory resolves after closeAll begins without starting it", async () => {
	const client = new FakeClient(null);
	client.startCompletion = deferred<RpcReadyFrame>();
	const factoryStarted = deferred<void>();
	const factoryCompletion = deferred<FleetRpcClient>();
	const fleet = new OmpFleetRun(
		{ name: "late factory", goal: "Work", window: "none", repos: { api: { cwd: "C:/api" } } },
		{
			fileSystem: new MemoryFileSystem(),
			runRoot: "C:/runs",
			idSource: () => "run-late-factory",
			clientFactory: () => {
				factoryStarted.resolve();
				return factoryCompletion.promise;
			},
		},
	);
	const finished = fleet.start();
	await factoryStarted.promise;
	const closing = fleet.closeAll();
	factoryCompletion.resolve(client);
	await closing;
	const snapshot = await finished;
	expect(client.startCount).toBe(0);
	expect(client.closeCount).toBe(1);
	expect(snapshot.workers[0].state).toBe("aborted");
	expect(snapshot.workers[0].closed).toBe(true);
});

test("waits for a raced abort acknowledgement before classifying prompt completion as aborted", async () => {
	const client = new FakeClient("must not be collected");
	client.abortCompletion = deferred<RpcResponseFrame>();
	client.onAbort = () => client.complete();
	const fleet = new OmpFleetRun(
		{ name: "abort race", goal: "Work", window: "none", repos: { api: { cwd: "C:/api" } } },
		{
			fileSystem: new MemoryFileSystem(),
			runRoot: "C:/runs",
			idSource: () => "run-abort-race",
			clientFactory: () => client,
		},
	);
	const finished = fleet.start();
	await client.promptStarted.promise;
	const acknowledgement = fleet.abort("api");
	await Promise.resolve();
	expect(client.closeCount).toBe(0);
	client.abortCompletion.resolve({ type: "response", command: "abort", success: true });
	await acknowledgement;
	const snapshot = await finished;
	expect(snapshot.workers[0].state).toBe("aborted");
	expect(fleet.getResults()).toEqual({});
	expect(client.closeCount).toBe(1);
});

test("lets raced prompt completion succeed when the pending abort is rejected", async () => {
	const client = new FakeClient("result after failed abort");
	client.abortCompletion = deferred<RpcResponseFrame>();
	client.onAbort = () => client.complete();
	const fleet = new OmpFleetRun(
		{ name: "abort rollback", goal: "Work", window: "none", repos: { api: { cwd: "C:/api" } } },
		{
			fileSystem: new MemoryFileSystem(),
			runRoot: "C:/runs",
			idSource: () => "run-abort-rollback",
			clientFactory: () => client,
			clock: () => "2026-08-08T00:00:00.000Z",
		},
	);
	const finished = fleet.start();
	await client.promptStarted.promise;
	const acknowledgement = fleet.abort("api");
	client.abortCompletion.reject(new Error("abort rejected"));
	await expect(acknowledgement).rejects.toThrow("abort rejected");
	const snapshot = await finished;
	expect(snapshot.workers[0].state).toBe("succeeded");
	expect(fleet.getResults()).toEqual({
		api: {
			repo: "api",
			text: "result after failed abort",
			completedAt: "2026-08-08T00:00:00.000Z",
		},
	});
});

test("shares one pending abort request and restores success eligibility when it rejects", async () => {
	const client = new FakeClient("result after concurrent abort failures");
	client.abortCompletion = deferred<RpcResponseFrame>();
	const fleet = new OmpFleetRun(
		{ name: "concurrent abort rollback", goal: "Work", window: "none", repos: { api: { cwd: "C:/api" } } },
		{
			fileSystem: new MemoryFileSystem(),
			runRoot: "C:/runs",
			idSource: () => "run-concurrent-abort-rollback",
			clientFactory: () => client,
		},
	);
	const finished = fleet.start();
	await client.promptStarted.promise;
	const firstAcknowledgement = fleet.abort("api");
	const secondAcknowledgement = fleet.abort("api");
	expect(secondAcknowledgement).toBe(firstAcknowledgement);
	expect(client.abortCount).toBe(1);
	client.abortCompletion.reject(new Error("abort rejected"));
	await expect(firstAcknowledgement).rejects.toThrow("abort rejected");
	client.complete();
	const snapshot = await finished;
	expect(client.abortCount).toBe(1);
	expect(snapshot.workers[0].state).toBe("succeeded");
	expect(fleet.getResults().api?.text).toBe("result after concurrent abort failures");
});

test("shares one pending abort acknowledgement and preserves aborted classification", async () => {
	const client = new FakeClient("must not be collected");
	client.abortCompletion = deferred<RpcResponseFrame>();
	client.onAbort = () => client.complete();
	const fleet = new OmpFleetRun(
		{ name: "concurrent abort success", goal: "Work", window: "none", repos: { api: { cwd: "C:/api" } } },
		{
			fileSystem: new MemoryFileSystem(),
			runRoot: "C:/runs",
			idSource: () => "run-concurrent-abort-success",
			clientFactory: () => client,
		},
	);
	const finished = fleet.start();
	await client.promptStarted.promise;
	const firstAcknowledgement = fleet.abort("api");
	const secondAcknowledgement = fleet.abort("api");
	expect(secondAcknowledgement).toBe(firstAcknowledgement);
	expect(client.abortCount).toBe(1);
	client.abortCompletion.resolve({ type: "response", command: "abort", success: true });
	await Promise.all([firstAcknowledgement, secondAcknowledgement]);
	const snapshot = await finished;
	expect(client.abortCount).toBe(1);
	expect(snapshot.workers[0].state).toBe("aborted");
	expect(fleet.getResults()).toEqual({});
});

test("closes a worker when the abort acknowledgement times out", async () => {
	const client = new FakeClient("must not be collected");
	client.abortCompletion = deferred<RpcResponseFrame>();
	const fleet = new OmpFleetRun(
		{ name: "abort timeout", goal: "Work", window: "none", repos: { api: { cwd: "C:/api" } } },
		{
			fileSystem: new MemoryFileSystem(),
			runRoot: "C:/runs",
			idSource: () => "run-abort-timeout",
			clientFactory: () => client,
			abortTimeoutMs: 5,
		},
	);
	const finished = fleet.start();
	await client.promptStarted.promise;

	await fleet.abort("api");
	const snapshot = await finished;

	expect(client.abortCount).toBe(1);
	expect(client.closeCount).toBe(1);
	expect(snapshot.workers[0].state).toBe("aborted");
	expect(fleet.getResults()).toEqual({});
});

test("abort during final result fetch wins over a successful result response", async () => {
	const client = new FakeClient("must not be collected");
	client.resultRequestCompletion = deferred<RpcResponseFrame>();
	const fleet = new OmpFleetRun(
		{ name: "result abort race", goal: "Work", window: "none", repos: { api: { cwd: "C:/api" } } },
		{
			fileSystem: new MemoryFileSystem(),
			runRoot: "C:/runs",
			idSource: () => "run-result-abort-race",
			clientFactory: () => client,
		},
	);
	const finished = fleet.start();
	await client.promptStarted.promise;
	client.complete();
	await client.requestStarted.promise;
	await fleet.abort("api");
	client.resultRequestCompletion.resolve({
		type: "response",
		command: "get_last_assistant_text",
		success: true,
		data: { text: "must not be collected" },
	});
	const snapshot = await finished;
	expect(snapshot.workers[0].state).toBe("aborted");
	expect(fleet.getResults()).toEqual({});
	expect(client.closeCount).toBe(1);
});

test("verifies repository directories before creating clients", async () => {
	const fs = new MemoryFileSystem();
	fs.nonDirectories.add("C:/missing");
	let created = false;
	const fleet = new OmpFleetRun(
		{ name: "cwd check", goal: "Work", window: "none", repos: { missing: { cwd: "C:/missing" } } },
		{
			fileSystem: fs,
			runRoot: "C:/runs",
			idSource: () => "run-cwd",
			clientFactory: () => {
				created = true;
				return new FakeClient(null);
			},
		},
	);
	const snapshot = await fleet.start();
	expect(created).toBe(false);
	expect(snapshot.workers[0].state).toBe("failed");
	expect(snapshot.workers[0].error).toContain("not a directory");
});

test("defaults to four workers and passes only an explicit minimal environment", async () => {
	expect(defaultFleetWorkerEnv({
		APPDATA: "C:/Users/test/AppData/Roaming",
		NODE_OPTIONS: "--require=malicious.js",
		PATH: "C:/bin",
		SERVICE_TOKEN: "secret",
		USERPROFILE: "C:/Users/test",
	})).toEqual({
		APPDATA: "C:/Users/test/AppData/Roaming",
		PATH: "C:/bin",
		USERPROFILE: "C:/Users/test",
	});

	const repos = Object.fromEntries(
		Array.from({ length: 5 }, (_, index) => [`repo-${index}`, { cwd: `C:/repos/${index}` }]),
	);
	const clients = Object.fromEntries(
		Array.from({ length: 5 }, (_, index) => [`repo-${index}`, new FakeClient(null)]),
	);
	const created: string[] = [];
	const fleet = new OmpFleetRun(
		{ name: "default concurrency", goal: "Work", window: "none", repos },
		{
			fileSystem: new MemoryFileSystem(),
			runRoot: "C:/runs",
			idSource: () => "run-default",
			envPolicy: context => ({ FLEET_REPO: context.repo }),
			clientFactory: context => {
				expect(context.env).toEqual({ FLEET_REPO: context.repo });
				created.push(context.repo);
				return clients[context.repo];
			},
		},
	);
	expect(fleet.getSnapshot().maxConcurrency).toBe(4);
	void fleet.start();
	await Promise.all(Object.values(clients).slice(0, 4).map(client => client.promptStarted.promise));
	expect(created).toEqual(["repo-0", "repo-1", "repo-2", "repo-3"]);
	await fleet.closeAll();
});
