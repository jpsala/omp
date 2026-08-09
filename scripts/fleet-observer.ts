import { open, readFile, stat, watch } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FleetEvent, FleetPersistedResultSummary, FleetPersistedSnapshot } from "../src/omp-fleet.ts";

type ObserverMode = "dashboard" | "repo";

export interface FleetObserverOptions {
	runId: string;
	root: string;
	mode: ObserverMode;
	repo?: string;
	once?: boolean;
}

export interface FleetObserverState {
	snapshot: FleetPersistedSnapshot;
	results: Record<string, FleetPersistedResultSummary>;
	events: FleetEvent[];
}

/** Remove terminal control sequences and control characters from artifact-provided text. */
export function neutralizeTerminalText(value: unknown): string {
	return String(value)
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "")
		.replace(/\u001b[P_X^][\s\S]*?\u001b\\/gu, "")
		.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu, "")
		.replace(/\u001b[ -/]*[@-~]/gu, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
}

function parseJsonFile<T>(text: string, name: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`Could not parse ${name}`, { cause: error });
	}
}

export function parseFleetObserverArgs(argv: readonly string[]): FleetObserverOptions {
	let runId: string | undefined;
	let root = fileURLToPath(new URL("../artifacts/fleet", import.meta.url));
	let mode: ObserverMode = "dashboard";
	let repo: string | undefined;
	let once = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--run") runId = argv[++index];
		else if (arg === "--root") {
			const value = argv[++index];
			if (!value) throw new Error("--root requires a path");
			root = resolve(value);
		} else if (arg === "--mode") {
			const value = argv[++index];
			if (value !== "dashboard" && value !== "repo") throw new Error("--mode must be dashboard or repo");
			mode = value;
		} else if (arg === "--repo") repo = argv[++index];
		else if (arg === "--once") once = true;
		else throw new Error(`Unknown observer argument: ${arg}`);
	}
	if (!runId) throw new Error("--run is required");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error("invalid fleet run id");
	if (mode === "repo" && !repo) throw new Error("--repo is required in repo mode");
	return { runId, root, mode, ...(repo ? { repo } : {}), ...(once ? { once } : {}) };
}

async function readOptional(path: string, fallback: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		throw error;
	}
}

export async function readFleetObserverState(runDirectory: string, events: FleetEvent[] = []): Promise<FleetObserverState> {
	const [snapshotText, resultsText] = await Promise.all([
		readFile(resolve(runDirectory, "snapshot.json"), "utf8"),
		readOptional(resolve(runDirectory, "results.json"), "{}"),
	]);
	return {
		snapshot: parseJsonFile<FleetPersistedSnapshot>(snapshotText, "snapshot.json"),
		results: parseJsonFile<Record<string, FleetPersistedResultSummary>>(resultsText, "results.json"),
		events,
	};
}

export function renderFleetObserver(state: FleetObserverState, options: Pick<FleetObserverOptions, "mode" | "repo">): string {
	const { snapshot } = state;
	const safe = neutralizeTerminalText;
	const workers = options.mode === "repo"
		? snapshot.workers.filter(worker => worker.repo === options.repo)
		: snapshot.workers;
	if (options.mode === "repo" && workers.length === 0) {
		throw new Error(`Unknown fleet repository: ${safe(options.repo)}`);
	}
	const lines = [
		`OMP Fleet: ${safe(snapshot.name)}`,
		`Run: ${safe(snapshot.runId)}`,
		`Started: ${safe(snapshot.startedAt ?? "waiting")}`,
		`Finished: ${safe(snapshot.finishedAt ?? "running")}`,
		"",
	];
	for (const worker of workers) {
		lines.push(`${safe(worker.repo).padEnd(20)} ${safe(worker.state)}${worker.closed ? " · closed" : ""}`);
		if (worker.pendingRequests.length > 0) {
			for (const request of worker.pendingRequests) {
				lines.push(`  pending: ${safe(request.method)} ${safe(request.id)}`);
			}
		}
		const result = state.results[worker.repo];
		if (result) lines.push(`  completed: ${safe(result.completedAt)}`);
		lines.push("");
	}
	const relevantEvents = state.events.filter(event => !options.repo || event.repo === options.repo).slice(-10);
	if (relevantEvents.length > 0) {
		lines.push("Recent events:");
		for (const event of relevantEvents) {
			lines.push(`  ${safe(event.time)} ${event.repo ? `${safe(event.repo)} ` : ""}${safe(event.type)}`);
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

async function readEventTail(path: string, offset: number): Promise<{ offset: number; events: FleetEvent[] }> {
	let size: number;
	try {
		size = (await stat(path)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { offset: 0, events: [] };
		throw error;
	}
	const start = size < offset ? 0 : offset;
	if (size === start) return { offset: size, events: [] };
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(size - start);
		const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, start);
		const bytes = buffer.subarray(0, bytesRead);
		const lastNewline = bytes.lastIndexOf(0x0a);
		if (lastNewline < 0) return { offset: start, events: [] };
		const events = bytes
			.subarray(0, lastNewline)
			.toString("utf8")
			.split("\n")
			.filter(Boolean)
			.map((line, index) => parseJsonFile<FleetEvent>(line, `events.jsonl line ${index + 1}`));
		return { offset: start + lastNewline + 1, events };
	} finally {
		await handle.close();
	}
}

/** Observe artifacts only. This process never opens, controls, or closes RPC workers. */
export async function observeFleetArtifacts(
	options: FleetObserverOptions,
	write: (text: string) => void = text => process.stdout.write(text),
): Promise<void> {
	const runDirectory = resolve(options.root, options.runId);
	const eventPath = resolve(runDirectory, "events.jsonl");
	let eventOffset = 0;
	let recentEvents: FleetEvent[] = [];
	const render = async (): Promise<void> => {
		const tail = await readEventTail(eventPath, eventOffset);
		eventOffset = tail.offset;
		recentEvents = [...recentEvents, ...tail.events].slice(-50);
		const state = await readFleetObserverState(runDirectory, recentEvents);
		write(`\u001b[2J\u001b[H${renderFleetObserver(state, options)}`);
	};
	await render();
	if (options.once) return;
	for await (const change of watch(runDirectory)) {
		if (change.filename === "events.jsonl" || change.filename === "snapshot.json" || change.filename === "results.json") {
			try {
				await render();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	observeFleetArtifacts(parseFleetObserverArgs(process.argv.slice(2))).catch(error => {
		process.stderr.write(`${neutralizeTerminalText(error instanceof Error ? error.message : error)}\n`);
		process.exitCode = 1;
	});
}
