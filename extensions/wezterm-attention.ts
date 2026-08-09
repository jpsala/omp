import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const ASK_TOOLS: Readonly<Record<string, true>> = {
	ask: true,
	ask_user: true,
	ask_user_question: true,
};

type AttentionState = "thinking" | "stop" | "notify";

function resolveAttentionTarget(): { pane: string; directory: string } | undefined {
	const pane = process.env.WEZTERM_PANE;
	if (!pane || !/^\d+$/.test(pane)) return undefined;
	const directory =
		process.env.WEZTERM_ATTENTION_DIR ?? join(process.env.HOME || homedir(), ".local", "state", "wezterm-attention");
	if (!isAbsolute(directory)) return undefined;
	return { pane, directory };
}

async function mark(state: AttentionState, label?: string): Promise<void> {
	const target = resolveAttentionTarget();
	if (!target) return;
	const { pane, directory } = target;

	const markerPath = join(directory, pane);
	const temporaryPath = `${markerPath}.tmp.${randomUUID()}`;
	const marker: Record<string, unknown> = {
		type: state,
		source: "omp",
		updated_at: Date.now(),
	};
	if (label) marker.label = label;
	if (state === "thinking") {
		const rawTtl = process.env.OMP_WEZTERM_ATTENTION_TTL_MS;
		const parsedTtl = rawTtl && /^\d+$/.test(rawTtl.trim()) ? Number.parseInt(rawTtl, 10) : Number.NaN;
		marker.ttl_ms = Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : DEFAULT_TTL_MS;
	}

	try {
		await mkdir(directory, { recursive: true });
		await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, "utf8");
		await rename(temporaryPath, markerPath);
	} catch {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

export default function weztermAttention(omp: ExtensionAPI): void {
	omp.registerCommand("wezterm-attention-status", {
		description: "Show the project-local WezTerm attention integration status",
		handler: async (_args, ctx) => {
			const target = resolveAttentionTarget();
			ctx.ui.notify(
				target ? `WezTerm attention active for pane ${target.pane}` : "WezTerm attention inactive in this pane",
				"info",
			);
		},
	});

	omp.on("agent_start", () => mark("thinking"));
	omp.on("tool_execution_start", () => mark("thinking"));
	omp.on("session_stop", () => mark("stop"));

	omp.on("tool_call", event => {
		if (ASK_TOOLS[event.toolName]) return mark("notify", "Waiting for your answer");
	});

	omp.on("tool_result", event => {
		if (ASK_TOOLS[event.toolName]) return mark("thinking");
	});
}
