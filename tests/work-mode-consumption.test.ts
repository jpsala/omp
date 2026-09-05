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

test("resuelve los cinco modos con el modelo y thinking efectivos", () => {
	expect(parseWorkMode("normal")).toBe("normal");
	expect(parseWorkMode("ligero")).toBe("ligero");
	expect(parseWorkMode("profundo")).toBe("profundo");
	expect(parseWorkMode("sol")).toBe("sol");
	expect(parseWorkMode("económico")).toBe("economic");
	expect(parseWorkMode("economic")).toBe("economic");
	expect(parseWorkMode("eco")).toBe("economic");
	expect(parseWorkMode("estado")).toBe("status");
	expect(() => parseWorkMode("fast")).toThrow("/modo");

	const astra = { provider: "openai-codex", id: "gpt-6-astra" };
	expect(inferWorkMode(astra, "medium")).toBe("normal");
	expect(inferWorkMode(astra, "low")).toBe("ligero");
	expect(inferWorkMode(astra, "high")).toBe("profundo");
	expect(inferWorkMode(astra, "xhigh")).toBe("personalizado");
	expect(inferWorkMode({ provider: "openai-codex", id: "gpt-5.6-sol" }, "medium")).toBe("sol");
	expect(inferWorkMode({ provider: "openai-codex", id: "gpt-5.6-luna" }, "high")).toBe("economic");
	expect(inferWorkMode({ provider: "custom", id: "gpt-6-astra" }, "medium")).toBe("personalizado");
	expect(inferWorkMode({ provider: "openai-codex", id: "future-model" }, "medium")).toBe("personalizado");

	expect(workModeModel("normal")).toEqual({ model: "openai-codex/gpt-6-astra", thinking: "medium" });
	expect(workModeModel("ligero")).toEqual({ model: "openai-codex/gpt-6-astra", thinking: "low" });
	expect(workModeModel("profundo")).toEqual({ model: "openai-codex/gpt-6-astra", thinking: "high" });
	expect(workModeModel("sol")).toEqual({ model: "openai-codex/gpt-5.6-sol", thinking: "medium" });
	expect(workModeModel("economic")).toEqual({ model: "openai-codex/gpt-5.6-luna", thinking: "high" });
	expect(workModeStatus("personalizado")).toBe("personalizado");
	expect(workModeStatus("normal", 0.79)).toBe("0,79/normal");
	expect(workModeStatus("economic", 0.79)).toBe("0,79/económico");
});

test("actualiza el estado desde la selección externa y limpia la cuota al cambiar de sesión", async () => {
	const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
	let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	let paceHandler: ((value: unknown) => void) | undefined;
	let currentModel = { provider: "openai-codex", id: "gpt-6-astra" };
	let currentThinking = "medium";
	const selected: string[] = [];
	const thinking: string[] = [];
	workModeExtension({
		events: {
			on(channel: string, handler: (value: unknown) => void) {
				if (channel === "aos:quota-pace") paceHandler = handler;
			},
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			handlers[event] = handler;
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			if (name === "modo") commandHandler = command.handler;
		},
		async setModel(model: { provider: string; id: string }) {
			currentModel = model;
			selected.push(`${model.provider}/${model.id}`);
			return true;
		},
		getThinkingLevel() {
			return currentThinking;
		},
		setThinkingLevel(level: string) {
			currentThinking = level;
			thinking.push(level);
		},
	} as never);
	const statuses: string[] = [];
	const notices: string[] = [];
	const ctx = {
		model: currentModel,
		models: {
			resolve: (selector: string) => {
				const separator = selector.indexOf("/");
				return { provider: selector.slice(0, separator), id: selector.slice(separator + 1) };
			},
			current: () => currentModel,
		},
		sessionManager: { getSessionId: () => "session-1" },
		ui: {
			setStatus: (_key: string, value: string) => statuses.push(value),
			notify: (value: string) => notices.push(value),
		},
	};

	handlers.session_start?.({}, ctx);
	paceHandler?.({ ctx, pace: 0.79 });
	await commandHandler?.("economico", ctx);
	expect(selected).toEqual(["openai-codex/gpt-5.6-luna"]);
	expect(thinking).toEqual(["high"]);
	expect(statuses).toEqual(["normal", "0,79/normal", "0,79/económico"]);
	expect(notices.at(-1)).toContain("Luna High");

	currentModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
	currentThinking = "medium";
	handlers.message_start?.({}, ctx);
	expect(statuses.at(-1)).toBe("0,79/sol");
	currentModel = { provider: "openai-codex", id: "gpt-6-astra" };
	currentThinking = "low";
	handlers.before_provider_request?.({}, ctx);
	expect(statuses.at(-1)).toBe("0,79/ligero");

	currentModel = { provider: "custom", id: "custom-model" };
	currentThinking = "xhigh";
	handlers.turn_start?.({}, ctx);
	expect(statuses.at(-1)).toBe("0,79/personalizado");
	await commandHandler?.("estado", ctx);
	expect(notices.at(-1)).toContain("custom/custom-model");
	expect(notices.at(-1)).toContain("thinking xhigh");

	const switchedSession = { ...ctx, sessionManager: { getSessionId: () => "session-2" } };
	handlers.session_switch?.({}, switchedSession);
	expect(statuses.at(-1)).toBe("personalizado");
});

test("un cambio de modelo fallido conserva selección, thinking y modo anteriores", async () => {
	let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	let currentModel = { provider: "openai-codex", id: "gpt-6-astra" };
	let currentThinking = "medium";
	const notices: string[] = [];
	workModeExtension({
		events: { on() {} },
		on() {},
		registerCommand(_name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commandHandler = command.handler;
		},
		async setModel() {
			return false;
		},
		getThinkingLevel: () => currentThinking,
		setThinkingLevel: (level: string) => {
			currentThinking = level;
		},
	} as never);
	const ctx = {
		model: currentModel,
		models: {
			resolve: (selector: string) => ({ provider: "openai-codex", id: selector.slice("openai-codex/".length) }),
			current: () => currentModel,
		},
		sessionManager: { getSessionId: () => "session-failed" },
		ui: {
			setStatus() {},
			notify: (message: string) => notices.push(message),
		},
	};
	await commandHandler?.("profundo", ctx);
	expect(currentModel).toEqual({ provider: "openai-codex", id: "gpt-6-astra" });
	expect(currentThinking).toBe("medium");
	expect(notices.at(-1)).toContain("No se pudo activar");
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
