import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import workModeExtension from "../extensions/work-mode.ts";
import {
	modelCredits,
	parseConsumptionPeriod,
	queryConsumption,
	readConsumptionMarker,
	renderConsumption,
	writeConsumptionMarker,
} from "../src/codex-consumption.ts";
import { inferWorkMode, parseWorkMode, workModeModel, workModeStatus } from "../src/work-mode.ts";

test("parses and resolves normal and economic work modes", () => {
	expect(parseWorkMode("económico")).toBe("economic");
	expect(parseWorkMode("eco")).toBe("economic");
	expect(parseWorkMode("normal")).toBe("normal");
	expect(parseWorkMode("")).toBe("status");
	expect(() => parseWorkMode("fast")).toThrow("/modo");
	expect(inferWorkMode({ provider: "openai-codex", id: "gpt-5.6-luna" })).toBe("economic");
	expect(inferWorkMode({ provider: "openai-codex", id: "gpt-5.6-sol" })).toBe("normal");
	expect(workModeModel("economic")).toEqual({ model: "openai-codex/gpt-5.6-luna", thinking: "high" });
	expect(workModeStatus("normal")).toBe("normal");
	expect(workModeStatus("normal", 0.79)).toBe("0,79/normal");
	expect(workModeStatus("economic", 0.79)).toBe("0,79/económico");
});

test("switches the live parent and keeps a visible mode status", async () => {
	let startHandler: ((event: unknown, ctx: unknown) => void) | undefined;
	let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	let paceHandler: ((value: unknown) => void) | undefined;
	const selected: string[] = [];
	const thinking: string[] = [];
	workModeExtension({
		events: {
			on(channel: string, handler: (value: unknown) => void) {
				if (channel === "aos:quota-pace") paceHandler = handler;
			},
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			if (event === "session_start") startHandler = handler;
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			if (name === "modo") commandHandler = command.handler;
		},
		async setModel(model: { id: string }) {
			selected.push(model.id);
			return true;
		},
		setThinkingLevel(level: string) {
			thinking.push(level);
		},
	} as never);
	const statuses: string[] = [];
	const notices: string[] = [];
	const ctx = {
		model: { provider: "openai-codex", id: "gpt-5.6-sol" },
		models: { resolve: (id: string) => ({ id }) },
		sessionManager: { getSessionId: () => "session-1" },
		ui: {
			setStatus: (_key: string, value: string) => statuses.push(value),
			notify: (value: string) => notices.push(value),
		},
	};
	startHandler?.({}, ctx);
	paceHandler?.({ ctx, pace: 0.79 });
	await commandHandler?.("economico", ctx);
	expect(selected).toEqual(["openai-codex/gpt-5.6-luna"]);
	expect(thinking).toEqual(["high"]);
	expect(statuses).toEqual(["normal", "0,79/normal", "0,79/económico"]);
	expect(notices.at(-1)).toContain("Luna High");
});

test("aggregates session consumption with the official Sol and Luna rates", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-consumption-"));
	try {
		const dbPath = join(root, "stats.db");
		const db = new Database(dbPath);
		db.exec(`CREATE TABLE messages (
			session_file TEXT, model TEXT, provider TEXT, timestamp INTEGER, agent_type TEXT,
			input_tokens INTEGER, cache_read_tokens INTEGER, output_tokens INTEGER, duration REAL
		)`);
		const now = Date.now();
		const insert = db.prepare("INSERT INTO messages VALUES (?, ?, 'openai-codex', ?, ?, ?, ?, ?, ?)");
		insert.run("C:/sessions/session-abc.jsonl", "gpt-5.6-sol", now - 2_000, "main", 1_000_000, 1_000_000, 1_000_000, 1_000);
		insert.run("C:/sessions/session-abc.jsonl", "gpt-5.6-luna", now - 1_000, "subagent", 1_000_000, 1_000_000, 1_000_000, 2_000);
		insert.run("C:/sessions/other.jsonl", "gpt-5.6-sol", now - 1_000, "main", 1_000_000, 0, 0, 3_000);
		insert.finalize();
		db.close();

		expect(modelCredits("gpt-5.6-sol", 1_000_000, 1_000_000, 1_000_000)).toBe(610);
		expect(modelCredits("gpt-5.6-luna", 1_000_000, 1_000_000, 1_000_000)).toBe(35.5);
		const report = queryConsumption(dbPath, { since: now - 10_000, until: now, sessionId: "session-abc" });
		expect(report.requests).toBe(2);
		expect(report.credits).toBe(645.5);
		expect(report.solCredits).toBe(610);
		expect(report.lunaCredits).toBe(35.5);
		expect(renderConsumption(report)).toContain("Mix ponderado: Sol 94.5% · Luna 5.5%");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("parses intervals and persists a local since-last marker", async () => {
	const now = 1_000_000;
	expect(parseConsumptionPeriod("2h", now)).toEqual({ kind: "interval", since: now - 7_200_000 });
	expect(parseConsumptionPeriod("desde", now)).toEqual({ kind: "since-last" });
	const root = await mkdtemp(join(tmpdir(), "omp-marker-"));
	try {
		const marker = join(root, "cache", "marker.json");
		await writeConsumptionMarker(marker, 1234);
		expect(await readConsumptionMarker(marker)).toBe(1234);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
