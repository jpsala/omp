import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { resolve } from "node:path";
import { loadFleetConfig, type FleetWindowMode } from "../src/omp-fleet-config.ts";
import { OmpFleetRun, type FleetEvent, type FleetPendingUiRequest, type FleetSnapshot } from "../src/omp-fleet.ts";
import { openFleetWezTerm } from "../src/omp-fleet-wezterm.ts";

const STATUS_KEY = "omp-fleet";
const WIDGET_KEY = "omp-fleet";
const VISIBLE_EVENT_TYPES: Readonly<Record<FleetEvent["type"], true | undefined>> = {
	run_started: true,
	worker_state: true,
	worker_frame: undefined,
	ui_request: true,
	ui_response: true,
	result: true,
	warning: true,
	run_finished: true,
	run_closed: true,
};

export const FLEET_USAGE = [
	"/fleet run <config.json> [--window=none|dashboard|tabs]",
	"/fleet status [run-id]",
	"/fleet send <run-id> <repo> <message>",
	"/fleet follow-up <run-id> <repo> <message>",
	"/fleet approve <run-id> <repo> <request-id>",
	"/fleet deny <run-id> <repo> <request-id>",
	"/fleet cancel <run-id> <repo|all>",
	"/fleet results [run-id]",
	"/fleet window [run-id]",
	"/fleet clear",
].join("\n");

export interface FleetAutocompleteItem {
	value: string;
	label: string;
	description?: string;
	hint?: string;
}

export interface FleetAutocompleteRun {
	runId: string;
	repos: string[];
	pendingByRepo?: Record<string, string[]>;
}

const FLEET_SUBCOMMANDS = [
	{ name: "run", syntax: "run <config.json> [--window=none|dashboard|tabs]", description: "Start a fleet from a JSON config" },
	{ name: "status", syntax: "status [run-id]", description: "Show live fleet status" },
	{ name: "send", syntax: "send <run-id> <repo> <message>", description: "Steer a running repository worker" },
	{ name: "follow-up", syntax: "follow-up <run-id> <repo> <message>", description: "Queue a follow-up after the current turn" },
	{ name: "approve", syntax: "approve <run-id> <repo> <request-id>", description: "Review and approve a pending request" },
	{ name: "deny", syntax: "deny <run-id> <repo> <request-id>", description: "Deny a pending request" },
	{ name: "cancel", syntax: "cancel <run-id> <repo|all>", description: "Cancel one worker or the complete fleet" },
	{ name: "results", syntax: "results [run-id]", description: "Show completed repository results" },
	{ name: "window", syntax: "window [run-id]", description: "Open the read-only WezTerm observer" },
	{ name: "clear", syntax: "clear", description: "Clear Fleet status and widgets" },
] as const;

function completion(value: string, label: string, description?: string, hint?: string): FleetAutocompleteItem {
	return { value, label, ...(description ? { description } : {}), ...(hint ? { hint } : {}) };
}

/** Context-aware argument suggestions for the `/fleet` slash command. */
export function fleetArgumentCompletions(
	argumentPrefix: string,
	activeRuns: readonly FleetAutocompleteRun[] = [],
): FleetAutocompleteItem[] | null {
	const hasWhitespace = /\s/u.test(argumentPrefix);
	const trimmed = argumentPrefix.trim();
	if (!hasWhitespace) {
		const needle = trimmed.toLowerCase();
		return FLEET_SUBCOMMANDS.filter(command => command.name.startsWith(needle)).map(command =>
			completion(`${command.name} `, command.syntax, command.description, command.syntax.slice(command.name.length + 1)),
		);
	}

	const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/u);
	const subcommand = tokens[0];
	if (!subcommand) return null;
	const endsWithWhitespace = /\s$/u.test(argumentPrefix);
	if (subcommand === "run") {
		if ((tokens.length === 2 && endsWithWhitespace) || (tokens.length === 3 && !endsWithWhitespace)) {
			const configPath = tokens[1];
			const partial = tokens[2] ?? "";
			return ["tabs", "dashboard", "none"]
				.map(mode => `--window=${mode}`)
				.filter(option => option.startsWith(partial))
				.map(option => completion(`run ${configPath} ${option}`, option, `Open Fleet with ${option.slice(9)} observers`));
		}
		return null;
	}

	const runCommands: Record<string, true | undefined> = {
		status: true,
		results: true,
		window: true,
		send: true,
		"follow-up": true,
		approve: true,
		deny: true,
		cancel: true,
	};
	if (!runCommands[subcommand]) return null;
	const runPartial = tokens[1] ?? "";
	if (tokens.length === 1 || tokens.length === 2 && !endsWithWhitespace) {
		return activeRuns
			.filter(run => run.runId.startsWith(runPartial))
			.map(run => completion(`${subcommand} ${run.runId}`, run.runId, `${run.repos.length} repositories`));
	}

	if (subcommand === "status" || subcommand === "results" || subcommand === "window") return null;
	const run = activeRuns.find(candidate => candidate.runId === tokens[1]);
	if (!run) return null;
	const repoPartial = tokens[2] ?? "";
	if (tokens.length === 2 || tokens.length === 3 && !endsWithWhitespace) {
		const repos = subcommand === "cancel" ? [...run.repos, "all"] : run.repos;
		return repos
			.filter(repo => repo.startsWith(repoPartial))
			.map(repo => completion(`${subcommand} ${run.runId} ${repo}`, repo, repo === "all" ? "Every worker" : "Repository worker"));
	}

	if (subcommand !== "approve" && subcommand !== "deny") return null;
	const repo = tokens[2];
	const requestPartial = tokens[3] ?? "";
	if (tokens.length === 3 || tokens.length === 4 && !endsWithWhitespace) {
		return (run.pendingByRepo?.[repo] ?? [])
			.filter(requestId => requestId.startsWith(requestPartial))
			.map(requestId => completion(`${subcommand} ${run.runId} ${repo} ${requestId}`, requestId, "Pending UI request"));
	}
	return null;
}


interface FleetRunRecord {
	run: OmpFleetRun;
	settled: boolean;
	failure?: string;
	autoWindowMode: FleetWindowMode;
	autoWindowOpened: boolean;
	unsubscribe: () => void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function safeText(value: unknown): string {
	return String(value)
		.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}


function selectDisplayOptions(options: string[]): { labels: string[]; values: Map<string, string> } {
	const values = new Map<string, string>();
	const labels = options.map(option => {
		const base = safeText(option) || "(empty)";
		let label = base;
		let suffix = 2;
		while (values.has(label)) label = `${base} (${suffix++})`;
		values.set(label, option);
		return label;
	});
	return { labels, values };
}

function shorten(value: unknown, limit = 180): string {
	const text = safeText(value).replace(/\s+/gu, " ");
	return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

/** Split command text without invoking a shell. Backslashes remain literal except when escaping the active quote. */
export function parseFleetArguments(input: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let tokenStarted = false;
	let quote: "\"" | "'" | undefined;

	for (let index = 0; index < input.length; index++) {
		const character = input[index];
		if (quote) {
			if (character === quote) {
				quote = undefined;
				continue;
			}
			if (character === "\\" && (input[index + 1] === quote || input[index + 1] === "\\")) {
				token += input[++index];
				continue;
			}
			token += character;
			continue;
		}

		if (/\s/u.test(character)) {
			if (tokenStarted) {
				tokens.push(token);
				token = "";
				tokenStarted = false;
			}
			continue;
		}
		if (character === "\"" || character === "'") {
			quote = character;
			tokenStarted = true;
			continue;
		}
		tokenStarted = true;
		token += character;
	}

	if (quote) throw new Error(`Unterminated ${quote} quote`);
	if (tokenStarted) tokens.push(token);
	return tokens;
}

export type FleetCommand =
	| { subcommand: "help" | "clear" }
	| { subcommand: "run"; configPath: string; windowOverride?: FleetWindowMode }
	| { subcommand: "status" | "results" | "window"; runId?: string }
	| { subcommand: "send" | "follow-up"; runId: string; repo: string; message: string }
	| { subcommand: "approve" | "deny"; runId: string; repo: string; requestId: string }
	| { subcommand: "cancel"; runId: string; target: string };

export function parseFleetCommand(input: string): FleetCommand {
	const tokens = parseFleetArguments(input);
	const subcommand = tokens[0];
	if (!subcommand) return { subcommand: "help" };
	if (subcommand === "clear") {
		if (tokens.length !== 1) throw new Error(`Usage: ${FLEET_USAGE.split("\n")[9]}`);
		return { subcommand };
	}
	if (subcommand === "run") {
		if (tokens.length < 2 || tokens.length > 3) throw new Error(`Usage: ${FLEET_USAGE.split("\n")[0]}`);
		let windowOverride: FleetWindowMode | undefined;
		if (tokens[2] !== undefined) {
			const match = /^--window=(none|dashboard|tabs)$/u.exec(tokens[2]);
			if (!match) throw new Error("Window override must be --window=none, --window=dashboard, or --window=tabs");
			windowOverride = match[1] as FleetWindowMode;
		}
		return { subcommand, configPath: tokens[1], ...(windowOverride ? { windowOverride } : {}) };
	}
	if (subcommand === "status" || subcommand === "results" || subcommand === "window") {
		const usageIndex = subcommand === "status" ? 1 : subcommand === "results" ? 7 : 8;
		if (tokens.length > 2) throw new Error(`Usage: ${FLEET_USAGE.split("\n")[usageIndex]}`);
		return { subcommand, ...(tokens[1] ? { runId: tokens[1] } : {}) };
	}
	if (subcommand === "send" || subcommand === "follow-up") {
		const usageIndex = subcommand === "send" ? 2 : 3;
		if (tokens.length < 4) throw new Error(`Usage: ${FLEET_USAGE.split("\n")[usageIndex]}`);
		const message = tokens.slice(3).join(" ");
		if (message.trim().length === 0) throw new Error("Fleet message must not be empty");
		return { subcommand, runId: tokens[1], repo: tokens[2], message };
	}
	if (subcommand === "approve" || subcommand === "deny") {
		const usageIndex = subcommand === "approve" ? 4 : 5;
		if (tokens.length !== 4) throw new Error(`Usage: ${FLEET_USAGE.split("\n")[usageIndex]}`);
		return { subcommand, runId: tokens[1], repo: tokens[2], requestId: tokens[3] };
	}
	if (subcommand === "cancel") {
		if (tokens.length !== 3) throw new Error(`Usage: ${FLEET_USAGE.split("\n")[6]}`);
		return { subcommand, runId: tokens[1], target: tokens[2] };
	}
	throw new Error(`Unknown fleet subcommand: ${subcommand}\n${FLEET_USAGE}`);
}

export async function presentFleetApproval(
	run: Pick<OmpFleetRun, "approve" | "deny">,
	pending: FleetPendingUiRequest,
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	const title = safeText(pending.title ?? `${pending.repo}: ${pending.method} request`);
	const message = safeText(pending.message ?? "");
	const prompt = message ? `${title}\n\n${message}` : title;
	let value: string | undefined;
	if (pending.method === "confirm") {
		if (await ctx.ui.confirm(title, message)) {
			await run.approve(pending.repo, pending.id, pending.version);
			return true;
		}
		await run.deny(pending.repo, pending.id, pending.version);
		return false;
	}
	if (pending.method === "select") {
		const options = pending.options;
		if (!options || options.length === 0 || !options.every(option => typeof option === "string")) {
			throw new Error(`Pending select request ${pending.id} does not contain string options`);
		}
		const display = selectDisplayOptions(options as string[]);
		const selectedLabel = await ctx.ui.select(prompt, display.labels);
		if (selectedLabel === undefined) {
			await run.deny(pending.repo, pending.id, pending.version);
			return false;
		}
		if (!display.values.has(selectedLabel)) {
			throw new Error(`Pending select request ${pending.id} returned an unknown option`);
		}
		value = display.values.get(selectedLabel);
	} else if (pending.method === "input") {
		value = await ctx.ui.input(prompt, pending.placeholder ? safeText(pending.placeholder) : undefined);
	} else if (pending.method === "editor") {
		value = await ctx.ui.editor(
			prompt,
			typeof pending.prefill === "string"
				? pending.prefill.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
				: undefined,
		);
	} else {
		throw new Error(`Unsupported pending UI method: ${pending.method}`);
	}
	if (value === undefined) {
		await run.deny(pending.repo, pending.id, pending.version);
		return false;
	}
	await run.approve(pending.repo, pending.id, pending.version, value);
	return true;
}

function commandArgument(value: string): string {
	return /^[A-Za-z0-9._-]+$/u.test(value) ? value : `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function counts(snapshot: FleetSnapshot): { succeeded: number; failed: number; aborted: number; active: number } {
	let succeeded = 0;
	let failed = 0;
	let aborted = 0;
	let active = 0;
	for (const worker of snapshot.workers) {
		if (worker.state === "succeeded") succeeded++;
		else if (worker.state === "failed") failed++;
		else if (worker.state === "aborted") aborted++;
		else active++;
	}
	return { succeeded, failed, aborted, active };
}

export function fleetCompletionSummary(snapshot: FleetSnapshot): {
	clean: boolean;
	message: string;
	lines: string[];
} {
	const totals = counts(snapshot);
	const clean =
		totals.succeeded === snapshot.workers.length &&
		totals.failed === 0 &&
		totals.aborted === 0 &&
		totals.active === 0;
	const message = clean
		? `Fleet ${safeText(snapshot.name)}: ${totals.succeeded}/${snapshot.workers.length} repositories succeeded.`
		: `Fleet ${safeText(snapshot.name)}: ${totals.succeeded} succeeded, ${totals.failed} failed, ${totals.aborted} aborted, ${totals.active} active.`;
	const lines = [
		message,
		`Run: ${safeText(snapshot.runId)}`,
		...snapshot.workers.slice(0, 7).map(worker => {
			const error = worker.error ? `: ${shorten(worker.error, 90)}` : "";
			return `${worker.state.toUpperCase()} ${safeText(worker.repo)}${error}`;
		}),
	];
	if (snapshot.workers.length > 7) lines.push(`... ${snapshot.workers.length - 7} more repositories`);
	return { clean, message, lines };
}

function renderRun(record: FleetRunRecord, ctx: ExtensionCommandContext): void {
	const snapshot = record.run.getSnapshot();
	const totals = counts(snapshot);
	const phase = record.failure ? "failed" : record.settled || snapshot.finishedAt ? "complete" : snapshot.startedAt ? "running" : "queued";
	ctx.ui.setStatus(
		STATUS_KEY,
		`fleet ${safeText(snapshot.name)}: ${phase}; ${totals.succeeded} ok, ${totals.failed} failed, ${totals.aborted} aborted, ${totals.active} active`,
	);

	const workerLimit = snapshot.workers.length > 7 ? 6 : 7;
	const lines = [
		`OMP Fleet: ${safeText(snapshot.name)} [${phase}]`,
		`Run: ${safeText(snapshot.runId)}`,
	];
	for (const worker of snapshot.workers.slice(0, workerLimit)) {
		const pending = worker.pendingRequests[0];
		const detail = pending
			? `; approval ${safeText(pending.method)} ${safeText(pending.id)}`
			: worker.error
				? `; ${shorten(worker.error, 90)}`
				: "";
		lines.push(`${safeText(worker.repo)}: ${worker.state}${detail}`);
	}
	if (snapshot.workers.length > workerLimit) lines.push(`... ${snapshot.workers.length - workerLimit} more repositories`);
	if (record.failure) lines.push(`Run error: ${shorten(record.failure, 140)}`);
	lines.push(`Artifacts: ${safeText(record.run.runDirectory)}`);
	ctx.ui.setWidget(WIDGET_KEY, lines.slice(0, 10), { placement: "aboveEditor" });
}

function renderResults(record: FleetRunRecord, ctx: ExtensionCommandContext): void {
	const summary = fleetCompletionSummary(record.run.getSnapshot());
	ctx.ui.setWidget(WIDGET_KEY, summary.lines.slice(0, 10), { placement: "aboveEditor" });
}


async function openObserverWindow(
	record: FleetRunRecord,
	mode: FleetWindowMode,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const effectiveMode = mode === "none" ? "dashboard" : mode;
	const runId = safeText(record.run.runId);
	const result = await openFleetWezTerm({
		runId: record.run.runId,
		runDirectory: record.run.runDirectory,
		mode: effectiveMode,
		repositories: record.run.getSnapshot().workers.map(worker => ({ name: worker.repo, cwd: worker.cwd })),
	});
	for (const warning of result.warnings) ctx.ui.notify(`Fleet ${runId} observer: ${shorten(warning)}`, "warning");
	if (result.opened) ctx.ui.notify(`Opened ${effectiveMode} observer for fleet ${runId}`, "info");
	else if (result.warnings.length === 0) ctx.ui.notify(`Fleet ${runId} observer did not open a window`, "warning");
}

function pendingNotification(record: FleetRunRecord, repo: string, ctx: ExtensionCommandContext): void {
	const worker = record.run.getSnapshot().workers.find(candidate => candidate.repo === repo);
	const pending = worker?.pendingRequests.at(-1);
	if (!pending) return;
	const runId = commandArgument(record.run.runId);
	const approve = `/fleet approve ${runId} ${commandArgument(repo)} ${commandArgument(pending.id)}`;
	const deny = `/fleet deny ${runId} ${commandArgument(repo)} ${commandArgument(pending.id)}`;
	ctx.ui.notify(
		`${safeText(repo)} requests ${safeText(pending.method)} (${safeText(pending.id)}) in fleet ${safeText(record.run.runId)}. Review it, then run ${approve} or ${deny}`,
		"warning",
	);
}

export default function ompFleetExtension(omp: ExtensionAPI): void {
	const runs = new Map<string, FleetRunRecord>();
	let latestRunId: string | undefined;

	const findRun = (runId?: string): FleetRunRecord => {
		const selectedId = runId ?? latestRunId;
		if (!selectedId) throw new Error("No fleet runs are registered in this session");
		const record = runs.get(selectedId);
		if (!record) throw new Error(`Unknown fleet run: ${selectedId}`);
		return record;
	};


	const startRun = async (
		configArgument: string,
		windowOverride: FleetWindowMode | undefined,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		const configPath = resolve(ctx.cwd, configArgument);
		const loaded = await loadFleetConfig(configPath);
		const config = windowOverride ? { ...loaded, window: windowOverride } : loaded;
		const run = new OmpFleetRun(config);
		const record: FleetRunRecord = {
			run,
			settled: false,
			autoWindowMode: config.window,
			autoWindowOpened: false,
			unsubscribe: () => undefined,
		};
		record.unsubscribe = run.subscribe(event => {
			if (VISIBLE_EVENT_TYPES[event.type] && latestRunId === run.runId) renderRun(record, ctx);
			if (event.type === "ui_request" && event.repo) pendingNotification(record, event.repo, ctx);
			if (event.type === "run_started" && record.autoWindowMode !== "none" && !record.autoWindowOpened) {
				record.autoWindowOpened = true;
				void openObserverWindow(record, record.autoWindowMode, ctx).catch(error => {
					ctx.ui.notify(`Fleet ${safeText(run.runId)} observer failed: ${shorten(errorMessage(error))}`, "warning");
				});
			}
		});
		runs.set(run.runId, record);
		latestRunId = run.runId;
		renderRun(record, ctx);
		ctx.ui.notify(`Fleet ${safeText(config.name)} queued as ${safeText(run.runId)}`, "info");

		const completion = run.start();
		void completion
			.then(snapshot => {
				record.settled = true;
				const summary = fleetCompletionSummary(snapshot);
				if (latestRunId === run.runId) {
					if (summary.clean) {
						ctx.ui.setStatus(STATUS_KEY, undefined);
						ctx.ui.setWidget(WIDGET_KEY, undefined);
					} else {
						renderRun(record, ctx);
					}
				}
				ctx.ui.notify(summary.message, summary.clean ? "info" : "warning");
			})
			.catch(error => {
				record.settled = true;
				record.failure = errorMessage(error);
				if (latestRunId === run.runId) renderRun(record, ctx);
				ctx.ui.notify(`Fleet ${safeText(run.runId)} failed: ${shorten(record.failure)}`, "error");
			});
	};

	const approveRequest = async (record: FleetRunRecord, repo: string, requestId: string, ctx: ExtensionCommandContext) => {
		const pending = record.run.getPendingRequest(repo, requestId);
		if (!pending) throw new Error(`No pending UI request ${requestId} for ${repo}`);
		const approved = await presentFleetApproval(record.run, pending, ctx);
		ctx.ui.notify(
			`${approved ? "Approved" : "Denied"} ${safeText(repo)} request ${safeText(requestId)} in fleet ${safeText(record.run.runId)}`,
			"info",
		);
		renderRun(record, ctx);
	};

	const dispatch = async (command: FleetCommand, ctx: ExtensionCommandContext): Promise<void> => {
		if (command.subcommand === "help") {
			ctx.ui.notify(FLEET_USAGE, "info");
			return;
		}
		if (command.subcommand === "clear") {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		if (command.subcommand === "run") {
			await startRun(command.configPath, command.windowOverride, ctx);
			return;
		}
		if (command.subcommand === "status") {
			if (!latestRunId && !command.runId) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.setWidget(WIDGET_KEY, ["OMP Fleet", "No runs in this session."], { placement: "aboveEditor" });
				ctx.ui.notify("No fleet runs are registered in this session", "info");
				return;
			}
			const record = findRun(command.runId);
			renderRun(record, ctx);
			ctx.ui.notify(`Showing fleet status for ${safeText(record.run.runId)}`, "info");
			return;
		}
		if (command.subcommand === "send" || command.subcommand === "follow-up") {
			const record = findRun(command.runId);
			if (command.subcommand === "send") await record.run.steer(command.repo, command.message);
			else await record.run.followUp(command.repo, command.message);
			ctx.ui.notify(
				`${command.subcommand === "send" ? "Sent" : "Queued follow-up"} for ${safeText(command.repo)} in fleet ${safeText(record.run.runId)}`,
				"info",
			);
			return;
		}
		if (command.subcommand === "approve" || command.subcommand === "deny") {
			const record = findRun(command.runId);
			if (command.subcommand === "approve") await approveRequest(record, command.repo, command.requestId, ctx);
			else {
				const pending = record.run.getPendingRequest(command.repo, command.requestId);
				if (!pending) throw new Error(`No pending UI request ${command.requestId} for ${command.repo}`);
				await record.run.deny(command.repo, command.requestId, pending.version);
				ctx.ui.notify(
					`Denied ${safeText(command.repo)} request ${safeText(command.requestId)} in fleet ${safeText(record.run.runId)}`,
					"info",
				);
				renderRun(record, ctx);
			}
			return;
		}
		if (command.subcommand === "cancel") {
			const record = findRun(command.runId);
			if (command.target === "all") {
				ctx.ui.notify(`Cancelling all workers in fleet ${safeText(record.run.runId)}`, "info");
				void record.run.closeAll().catch(error => {
					ctx.ui.notify(
						`Fleet ${safeText(record.run.runId)} cancellation failed: ${shorten(errorMessage(error))}`,
						"error",
					);
				});
			} else {
				await record.run.abort(command.target);
				ctx.ui.notify(
					`Cancellation requested for ${safeText(command.target)} in fleet ${safeText(record.run.runId)}`,
					"info",
				);
			}
			return;
		}
		if (command.subcommand === "results") {
			renderResults(findRun(command.runId), ctx);
			return;
		}
		const record = findRun(command.runId);
		await openObserverWindow(record, record.run.config.window, ctx);
	};

	omp.registerCommand("fleet", {
		description: "Run and control a multi-repository OMP fleet",
		getArgumentCompletions: argumentPrefix =>
			fleetArgumentCompletions(
				argumentPrefix,
				[...runs.values()].map(record => {
					const snapshot = record.run.getSnapshot();
					return {
						runId: record.run.runId,
						repos: Object.entries(record.run.config.repos)
							.filter(([, repo]) => repo.enabled !== false)
							.map(([repo]) => repo),
						pendingByRepo: Object.fromEntries(
							snapshot.workers.map(worker => [
								worker.repo,
								worker.pendingRequests.map(request => request.id),
							]),
						),
					};
				}),
			),
		handler: async (args, ctx) => {
			let command: FleetCommand | undefined;
			try {
				command = parseFleetCommand(args);
				await dispatch(command, ctx);
			} catch (error) {
				const runId = command && "runId" in command ? ` ${safeText(command.runId)}` : "";
				ctx.ui.notify(`Fleet${runId} command failed: ${shorten(errorMessage(error), 300)}`, "error");
			}
		},
	});

	omp.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	omp.on("session_shutdown", async (_event, ctx) => {
		await Promise.allSettled([...runs.values()].filter(record => !record.settled).map(record => record.run.closeAll()));
		for (const record of runs.values()) record.unsubscribe();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
