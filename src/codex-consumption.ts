import { Database } from "bun:sqlite";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ConsumptionRow {
	model: string;
	agentType: string;
	requests: number;
	inputTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
	durationMs: number;
	credits: number;
}

export interface ConsumptionReport {
	since: number;
	until: number;
	sessionId?: string;
	rows: ConsumptionRow[];
	requests: number;
	inputTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
	durationMs: number;
	credits: number;
	solCredits: number;
	lunaCredits: number;
}

interface AggregateRow {
	model: string;
	agent_type: string | null;
	requests: number;
	input_tokens: number;
	cache_read_tokens: number;
	output_tokens: number;
	duration_ms: number;
}

export function modelCredits(model: string, inputTokens: number, cacheReadTokens: number, outputTokens: number): number {
	if (model === "gpt-5.6-sol") return (100 * inputTokens + 10 * cacheReadTokens + 500 * outputTokens) / 1_000_000;
	if (model === "gpt-5.6-luna") return (5 * inputTokens + 0.5 * cacheReadTokens + 30 * outputTokens) / 1_000_000;
	return 0;
}

export function parseConsumptionPeriod(value: string, now = Date.now()): { kind: "session" | "since-last" | "interval"; since?: number } {
	const normalized = value.trim().toLowerCase();
	if (!normalized || normalized === "session" || normalized === "sesion" || normalized === "sesión") return { kind: "session" };
	if (normalized === "desde" || normalized === "since" || normalized === "since-last" || normalized === "ultima" || normalized === "última") {
		return { kind: "since-last" };
	}
	const match = /^(\d+(?:\.\d+)?)(m|h|d)$/u.exec(normalized);
	if (!match) throw new Error("Uso: /consumo [sesion|2h|30m|1d|desde|marcar]");
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) throw new Error("El intervalo debe ser positivo");
	const unitMs = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
	return { kind: "interval", since: now - amount * unitMs };
}

export function queryConsumption(dbPath: string, options: { since: number; until?: number; sessionId?: string }): ConsumptionReport {
	const until = options.until ?? Date.now();
	const db = new Database(dbPath, { readonly: true });
	try {
		const sessionClause = options.sessionId ? " AND session_file LIKE ?" : "";
		const sql = `
			SELECT model, COALESCE(agent_type, 'unknown') AS agent_type,
				COUNT(*) AS requests,
				COALESCE(SUM(input_tokens), 0) AS input_tokens,
				COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
				COALESCE(SUM(output_tokens), 0) AS output_tokens,
				COALESCE(SUM(duration), 0) AS duration_ms
			FROM messages
			WHERE provider = 'openai-codex' AND timestamp >= ? AND timestamp <= ?${sessionClause}
			GROUP BY model, agent_type
			ORDER BY requests DESC`;
		const raw = options.sessionId
			? db.query<AggregateRow, [number, number, string]>(sql).all(options.since, until, `%${options.sessionId}%`)
			: db.query<AggregateRow, [number, number]>(sql).all(options.since, until);
		const rows = raw.map(row => ({
			model: row.model,
			agentType: row.agent_type ?? "unknown",
			requests: Number(row.requests),
			inputTokens: Number(row.input_tokens),
			cacheReadTokens: Number(row.cache_read_tokens),
			outputTokens: Number(row.output_tokens),
			durationMs: Number(row.duration_ms),
			credits: modelCredits(row.model, Number(row.input_tokens), Number(row.cache_read_tokens), Number(row.output_tokens)),
		}));
		const sum = (pick: (row: ConsumptionRow) => number): number => rows.reduce((total, row) => total + pick(row), 0);
		return {
			since: options.since,
			until,
			...(options.sessionId ? { sessionId: options.sessionId } : {}),
			rows,
			requests: sum(row => row.requests),
			inputTokens: sum(row => row.inputTokens),
			cacheReadTokens: sum(row => row.cacheReadTokens),
			outputTokens: sum(row => row.outputTokens),
			durationMs: sum(row => row.durationMs),
			credits: sum(row => row.credits),
			solCredits: sum(row => row.model === "gpt-5.6-sol" ? row.credits : 0),
			lunaCredits: sum(row => row.model === "gpt-5.6-luna" ? row.credits : 0),
		};
	} finally {
		db.close();
	}
}

export function renderConsumption(report: ConsumptionReport): string {
	const hours = Math.max((report.until - report.since) / 3_600_000, 1 / 60);
	const solShare = report.credits > 0 ? (100 * report.solCredits) / report.credits : 0;
	const lunaShare = report.credits > 0 ? (100 * report.lunaCredits) / report.credits : 0;
	const lines = [
		`Consumo ${report.sessionId ? "de esta sesión" : `desde ${new Date(report.since).toLocaleString()}`}`,
		`Requests: ${report.requests} · créditos equivalentes: ${report.credits.toFixed(1)} · ritmo: ${(report.credits / hours).toFixed(1)} créditos/h`,
		`Input: ${report.inputTokens.toLocaleString()} · cache: ${report.cacheReadTokens.toLocaleString()} · output: ${report.outputTokens.toLocaleString()}`,
		`Mix ponderado: Sol ${solShare.toFixed(1)}% · Luna ${lunaShare.toFixed(1)}%`,
	];
	for (const row of report.rows) lines.push(`${row.model} (${row.agentType}): ${row.requests} req · ${row.credits.toFixed(1)} créditos`);
	if (report.rows.some(row => row.credits === 0 && row.requests > 0)) lines.push("Hay modelos sin rate card local; sus créditos no están incluidos.");
	lines.push("Estimación local por tokens; omp usage conserva la autoridad sobre la cuota real del plan.");
	return lines.join("\n");
}

export async function readConsumptionMarker(path: string): Promise<number | undefined> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as { timestamp?: unknown };
		return typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp) ? parsed.timestamp : undefined;
	} catch {
		return undefined;
	}
}

export async function writeConsumptionMarker(path: string, timestamp = Date.now()): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ timestamp })}\n`, "utf8");
	await rename(temporary, path);
}
