import { mkdir, rename, utimes, writeFile } from "node:fs/promises";
import { basename, win32 } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	DEFAULT_LIVE_MARKDOWN_ROOT,
	LiveMarkdownDocument,
	sessionMarkdownPath,
	type MirrorMessage,
} from "./live-markdown-core.ts";

const WRITE_DELAY_MS = 60;

export interface LiveMarkdownDependencies {
	interactive?: boolean;
	outputRoot?: string;
	ensureDirectory?: (path: string) => Promise<void>;
	writeSnapshot?: (path: string, content: string) => Promise<void>;
	moveSnapshot?: (source: string, destination: string) => Promise<void>;
	touchDirectory?: (path: string, timestamp: Date) => Promise<void>;
}

interface MirrorRuntime {
	ctx: ExtensionContext;
	document: LiveMarkdownDocument;
	filePath: string;
	sessionId: string;
	startedAt: Date;
	pane?: string;
	generating: boolean;
	directoryReady: boolean;
	writeRunning: boolean;
	pendingContent?: string;
	writeTimer?: Timer;
}

function branchMessages(ctx: ExtensionContext): MirrorMessage[] {
	const messages: MirrorMessage[] = [];
	for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
		if (entry.type !== "message") continue;
		const message = entry.message as MirrorMessage;
		if (message.role === "user" || message.role === "assistant") messages.push(message);
	}
	return messages;
}

function repositoryName(cwd: string): string {
	return basename(cwd.replace(/[\\/]+$/, "")) || cwd;
}

function activityDirectories(filePath: string, outputRoot: string): string[] {
	const root = win32.resolve(outputRoot);
	const directories: string[] = [];
	let current = win32.dirname(filePath);
	while (current !== root) {
		const relative = win32.relative(root, current);
		if (win32.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${win32.sep}`)) break;
		directories.push(current);
		current = win32.dirname(current);
	}
	return directories;
}


export default function liveMarkdown(pi: ExtensionAPI, dependencies: LiveMarkdownDependencies = {}): void {
	let runtime: MirrorRuntime | undefined;

	const outputRoot =
		dependencies.outputRoot ?? process.env.OMP_LIVE_MARKDOWN_ROOT?.trim() ?? DEFAULT_LIVE_MARKDOWN_ROOT;
	const interactive = dependencies.interactive ?? process.stdout.isTTY === true;
	const ensureDirectory =
		dependencies.ensureDirectory ??
		(async (path: string): Promise<void> => {
			await mkdir(path, { recursive: true });
		});
	const writeSnapshot =
		dependencies.writeSnapshot ??
		(async (path: string, content: string): Promise<void> => {
			await writeFile(path, content, "utf8");
		});
	const moveSnapshot = dependencies.moveSnapshot ?? rename;
	const touchDirectory =
		dependencies.touchDirectory ??
		(async (path: string, timestamp: Date): Promise<void> => {
			await utimes(path, timestamp, timestamp);
		});

	const drainWrites = async (current: MirrorRuntime): Promise<void> => {
		current.writeRunning = true;
		while (current.pendingContent !== undefined) {
			const content = current.pendingContent;
			current.pendingContent = undefined;
			try {
				const desiredPath = sessionMarkdownPath({
					cwd: current.ctx.cwd,
					sessionId: current.sessionId,
					pane: current.pane,
					title: pi.getSessionName?.(),
					startedAt: current.startedAt,
					outputRoot,
				});
				if (!current.directoryReady) {
					await ensureDirectory(win32.dirname(desiredPath));
					current.directoryReady = true;
				}
				if (desiredPath !== current.filePath) {
					try {
						await moveSnapshot(current.filePath, desiredPath);
					} catch (error) {
						if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
					}
					current.filePath = desiredPath;
				}
				await writeSnapshot(current.filePath, content);
				const timestamp = new Date();
				await Promise.all(
					activityDirectories(current.filePath, outputRoot).map(directory =>
						touchDirectory(directory, timestamp),
					),
				);
			} catch (error) {
				pi.logger.error("Live Markdown filesystem update failed", {
					error: error instanceof Error ? error.message : String(error),
					filePath: current.filePath,
				});
			}
		}
		current.writeRunning = false;
	};

	const enqueueWrite = (current: MirrorRuntime): void => {
		try {
			current.pendingContent = current.document.render({
				repository: repositoryName(current.ctx.cwd),
				cwd: current.ctx.cwd,
				sessionId: current.sessionId,
				pane: process.env.WEZTERM_PANE?.trim() || undefined,
				generating: current.generating,
				updatedAt: new Date(),
			});
			if (!current.writeRunning) void drainWrites(current);
		} catch (error) {
			pi.logger.error("Live Markdown snapshot failed", {
				error: error instanceof Error ? error.message : String(error),
				filePath: current.filePath,
			});
		}
	};

	const flush = (current = runtime): void => {
		if (!current) return;
		if (current.writeTimer) {
			current.ctx.clearTimer(current.writeTimer);
			current.writeTimer = undefined;
		}
		enqueueWrite(current);
	};

	const scheduleWrite = (current = runtime): void => {
		if (!current) return;
		if (current.writeTimer) current.ctx.clearTimer(current.writeTimer);
		current.writeTimer = current.ctx.setTimeout(() => {
			current.writeTimer = undefined;
			enqueueWrite(current);
		}, WRITE_DELAY_MS);
	};

	const initialize = (ctx: ExtensionContext): void => {
		if (ctx.hasUI !== true || !interactive) {
			runtime = undefined;
			return;
		}
		if (runtime) flush(runtime);
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (!sessionId) {
			runtime = undefined;
			return;
		}
		try {
			const headerTimestamp = ctx.sessionManager?.getHeader?.()?.timestamp;
			const headerDate = headerTimestamp ? new Date(headerTimestamp) : undefined;
			const startedAt = headerDate && !Number.isNaN(headerDate.getTime()) ? headerDate : new Date();
			const document = new LiveMarkdownDocument();
			const messages = branchMessages(ctx);
			document.reset(messages);
			runtime = {
				ctx,
				document,
				filePath: sessionMarkdownPath({
					cwd: ctx.cwd,
					sessionId,
					pane: process.env.WEZTERM_PANE,
					startedAt,
					title: pi.getSessionName?.(),
					outputRoot,
				}),
				sessionId,
				startedAt,
				pane: process.env.WEZTERM_PANE?.trim() || undefined,
				generating: false,
				directoryReady: false,
				writeRunning: false,
			};
			flush(runtime);
		} catch (error) {
			runtime = undefined;
			pi.logger.error("Live Markdown initialization failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const matchesRuntime = (ctx: ExtensionContext): boolean =>
		runtime?.sessionId === ctx.sessionManager?.getSessionId?.();

	pi.on("session_start", (_event, ctx) => initialize(ctx));
	pi.on("session_switch", (_event, ctx) => initialize(ctx));
	pi.on("session_branch", (_event, ctx) => initialize(ctx));
	pi.on("session_tree", (_event, ctx) => initialize(ctx));

	pi.on("agent_start", (_event, ctx) => {
		if (!runtime || !matchesRuntime(ctx)) return;
		runtime.generating = true;
		scheduleWrite(runtime);
	});

	pi.on("message_start", (event, ctx) => {
		if (!runtime || !matchesRuntime(ctx)) return;
		const message = event.message as MirrorMessage;
		if (message.role === "user") {
			runtime.document.startUser(message);
			flush(runtime);
			return;
		}
		if (message.role !== "assistant") return;
		runtime.document.updateAssistant(message);
		scheduleWrite(runtime);
	});

	pi.on("message_update", (event, ctx) => {
		if (!runtime || !matchesRuntime(ctx)) return;
		const message = event.message as MirrorMessage;
		if (message.role !== "assistant") return;
		runtime.generating = true;
		runtime.document.updateAssistant(message);
		scheduleWrite(runtime);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (!runtime || !matchesRuntime(ctx)) return;
		runtime.generating = true;
		runtime.document.addProgress(event.intent?.trim() || "Trabajando…");
		scheduleWrite(runtime);
	});

	pi.on("message_end", (event, ctx) => {
		if (!runtime || !matchesRuntime(ctx)) return;
		const message = event.message as MirrorMessage;
		if (message.role !== "assistant") return;
		runtime.document.finishAssistant(message);
		flush(runtime);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!runtime || !matchesRuntime(ctx)) return;
		runtime.generating = false;
		flush(runtime);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!runtime || !matchesRuntime(ctx)) return;
		runtime.generating = false;
		flush(runtime);
		runtime = undefined;
	});

	pi.registerCommand("live-markdown", {
		description: "Show the live Markdown mirror path for this session",
		handler: (_args, ctx) => {
			if (!runtime || !matchesRuntime(ctx)) initialize(ctx);
			if (!runtime) {
				ctx.ui.notify("El espejo Markdown requiere una sesión TUI interactiva.", "warning");
				return;
			}
			flush(runtime);
			ctx.ui.notify(`Markdown en vivo: ${runtime.filePath}`, "info");
		},
	});
}
