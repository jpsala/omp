import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	DEFAULT_LIVE_MARKDOWN_ROOT,
	LiveMarkdownDocument,
	PRIVATE_MIRROR_VISIBILITY,
	sessionMarkdownPath,
	type MirrorMessage,
	type MirrorVisibility,
} from "./live-markdown-core.ts";
import type { TranscriptVisibilityState } from "./tool-activity-view-core.ts";

const WRITE_DELAY_MS = 60;

interface MirrorRuntime {
	ctx: ExtensionContext;
	document: LiveMarkdownDocument;
	filePath: string;
	sessionId: string;
	hasTranscript: boolean;
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
		if (message.role === "assistant") messages.push(message);
	}
	return messages;
}

function repositoryName(cwd: string): string {
	return basename(cwd.replace(/[\\/]+$/, "")) || cwd;
}

function mirrorVisibility(ctx: ExtensionContext): MirrorVisibility {
	try {
		const visibility = ctx.ui.getTranscriptVisibility?.() as TranscriptVisibilityState | undefined;
		if (!visibility) return PRIVATE_MIRROR_VISIBILITY;
		return {
			includeThinking: visibility.hideThinking === false,
			includeAssistantToolPreambles: visibility.hideAssistantToolPreambles === false,
		};
	} catch {
		return PRIVATE_MIRROR_VISIBILITY;
	}
}

export default function liveMarkdown(pi: ExtensionAPI): void {
	let runtime: MirrorRuntime | undefined;

	const outputRoot = process.env.OMP_LIVE_MARKDOWN_ROOT?.trim() || DEFAULT_LIVE_MARKDOWN_ROOT;

	const drainWrites = async (current: MirrorRuntime): Promise<void> => {
		current.writeRunning = true;
		while (current.pendingContent !== undefined) {
			const content = current.pendingContent;
			current.pendingContent = undefined;
			try {
				if (!current.directoryReady) {
					await mkdir(dirname(current.filePath), { recursive: true });
					current.directoryReady = true;
				}
				await writeFile(current.filePath, content, "utf8");
			} catch (error) {
				pi.logger.error("Live Markdown write failed", {
					error: error instanceof Error ? error.message : String(error),
					filePath: current.filePath,
				});
			}
		}
		current.writeRunning = false;
	};

	const enqueueWrite = (current: MirrorRuntime): void => {
		if (!current.hasTranscript) return;
		try {
			const visibility = mirrorVisibility(current.ctx);
			current.pendingContent = current.document.render(
				{
					repository: repositoryName(current.ctx.cwd),
					cwd: current.ctx.cwd,
					sessionId: current.sessionId,
					pane: process.env.WEZTERM_PANE?.trim() || undefined,
					generating: current.generating,
					updatedAt: new Date(),
				},
				visibility,
			);
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
		if (ctx.hasUI !== true) {
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
			const startedAt = new Date();
			const document = new LiveMarkdownDocument();
			const messages = branchMessages(ctx);
			const visibility = mirrorVisibility(ctx);
			document.reset(messages);
			runtime = {
				ctx,
				document,
				filePath: sessionMarkdownPath({
					cwd: ctx.cwd,
					sessionId,
					pane: process.env.WEZTERM_PANE,
					startedAt,
					outputRoot,
				}),
				sessionId,
				hasTranscript: document.hasContent(visibility),
				generating: false,
				directoryReady: false,
				writeRunning: false,
			};
			if (runtime.hasTranscript) flush(runtime);
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
		if (message.role !== "assistant") return;
		runtime.document.updateAssistant(message);
		runtime.hasTranscript = runtime.document.hasContent(mirrorVisibility(ctx));
		scheduleWrite(runtime);
	});

	pi.on("message_update", (event, ctx) => {
		if (!runtime || !matchesRuntime(ctx)) return;
		const message = event.message as MirrorMessage;
		if (message.role !== "assistant") return;
		runtime.generating = true;
		runtime.document.updateAssistant(message);
		runtime.hasTranscript = runtime.document.hasContent(mirrorVisibility(ctx));
		scheduleWrite(runtime);
	});

	pi.on("message_end", (event, ctx) => {
		if (!runtime || !matchesRuntime(ctx)) return;
		const message = event.message as MirrorMessage;
		if (message.role !== "assistant") return;
		runtime.document.finishAssistant(message);
		runtime.hasTranscript = runtime.document.hasContent(mirrorVisibility(ctx));
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
