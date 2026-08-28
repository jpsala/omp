import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
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

interface MirrorRuntime {
	ctx: ExtensionContext;
	document: LiveMarkdownDocument;
	filePath: string;
	sessionId: string;
	hasTranscript: boolean;
	generating: boolean;
	writeTimer?: Timer;
	writeQueue: Promise<void>;
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

export default function liveMarkdown(pi: ExtensionAPI): void {
	let runtime: MirrorRuntime | undefined;

	const outputRoot = process.env.OMP_LIVE_MARKDOWN_ROOT?.trim() || DEFAULT_LIVE_MARKDOWN_ROOT;

	const enqueueWrite = async (current: MirrorRuntime): Promise<void> => {
		if (!current.hasTranscript) return;
		const sessionName = pi.getSessionName()?.trim() || repositoryName(current.ctx.cwd);
		const content = current.document.render({
			repository: repositoryName(current.ctx.cwd),
			cwd: current.ctx.cwd,
			sessionId: current.sessionId,
			sessionName,
			pane: process.env.WEZTERM_PANE?.trim() || undefined,
			generating: current.generating,
			updatedAt: new Date(),
		});
		const filePath = current.filePath;
		current.writeQueue = current.writeQueue
			.then(async () => {
				await mkdir(dirname(filePath), { recursive: true });
				await writeFile(filePath, content, "utf8");
			})
			.catch(error => {
				pi.logger.error("Live Markdown write failed", {
					error: error instanceof Error ? error.message : String(error),
					filePath,
				});
			});
		await current.writeQueue;
	};

	const flush = async (current = runtime): Promise<void> => {
		if (!current) return;
		if (current.writeTimer) {
			current.ctx.clearTimer(current.writeTimer);
			current.writeTimer = undefined;
		}
		await enqueueWrite(current);
	};

	const scheduleWrite = (current = runtime): void => {
		if (!current) return;
		if (current.writeTimer) current.ctx.clearTimer(current.writeTimer);
		current.writeTimer = current.ctx.setTimeout(() => {
			current.writeTimer = undefined;
			void enqueueWrite(current);
		}, WRITE_DELAY_MS);
	};

	const initialize = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.hasUI !== true) {
			runtime = undefined;
			return;
		}
		if (runtime) await flush(runtime);
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (!sessionId) {
			runtime = undefined;
			return;
		}
		const startedAt = new Date();
		const document = new LiveMarkdownDocument();
		const messages = branchMessages(ctx);
		document.reset(messages);
		runtime = {
			ctx,
			document,
			filePath: sessionMarkdownPath({
				cwd: ctx.cwd,
				sessionId,
				sessionName: pi.getSessionName(),
				pane: process.env.WEZTERM_PANE,
				startedAt,
				outputRoot,
			}),
			sessionId,
			hasTranscript: messages.length > 0,
			generating: false,
			writeQueue: Promise.resolve(),
		};
		if (runtime.hasTranscript) await flush(runtime);
	};

	const matchesRuntime = (ctx: ExtensionContext): boolean =>
		runtime?.sessionId === ctx.sessionManager?.getSessionId?.();

	pi.on("session_start", async (_event, ctx) => initialize(ctx));
	pi.on("session_switch", async (_event, ctx) => initialize(ctx));
	pi.on("session_branch", async (_event, ctx) => initialize(ctx));
	pi.on("session_tree", async (_event, ctx) => initialize(ctx));

	pi.on("agent_start", (_event, ctx) => {
		if (!runtime || !matchesRuntime(ctx)) return;
		runtime.generating = true;
		scheduleWrite(runtime);
	});

	pi.on("message_start", (event, ctx) => {
		if (!runtime || !matchesRuntime(ctx)) return;
		runtime.hasTranscript = true;
		const message = event.message as MirrorMessage;
		if (message.role === "user") runtime.document.appendUser(message);
		else if (message.role === "assistant") runtime.document.updateAssistant(message);
		scheduleWrite(runtime);
	});

	pi.on("message_update", (event, ctx) => {
		if (!runtime || !matchesRuntime(ctx)) return;
		runtime.hasTranscript = true;
		runtime.generating = true;
		runtime.document.updateAssistant(event.message as MirrorMessage);
		scheduleWrite(runtime);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!runtime || !matchesRuntime(ctx)) return;
		const message = event.message as MirrorMessage;
		if (message.role === "assistant") runtime.document.finishAssistant(message);
		await flush(runtime);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!runtime || !matchesRuntime(ctx)) return;
		runtime.generating = false;
		await flush(runtime);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!runtime || !matchesRuntime(ctx)) return;
		runtime.generating = false;
		await flush(runtime);
		runtime = undefined;
	});

	pi.registerCommand("live-markdown", {
		description: "Show the live Markdown mirror path for this session",
		handler: async (_args, ctx) => {
			if (!runtime || !matchesRuntime(ctx)) await initialize(ctx);
			if (!runtime) {
				ctx.ui.notify("El espejo Markdown requiere una sesión TUI interactiva.", "warning");
				return;
			}
			runtime.hasTranscript = true;
			await flush(runtime);
			ctx.ui.notify(`Markdown en vivo: ${runtime.filePath}`, "info");
		},
	});
}
