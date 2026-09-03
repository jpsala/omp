import { createHash } from "node:crypto";
import { win32 } from "node:path";

export const DEFAULT_LIVE_MARKDOWN_ROOT = "C:\\dev\\omp-live";
export const DEFAULT_DEV_ROOT = "C:\\dev";

export interface MirrorContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
}

export interface MirrorMessage {
	role?: string;
	content?: string | readonly MirrorContentBlock[];
}


export interface LiveMarkdownMetadata {
	repository: string;
	cwd: string;
	sessionId: string;
	pane?: string;
	generating: boolean;
	updatedAt: Date;
}

interface RenderedMessage {
	body: string;
}

function cleanText(value: string): string {
	return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").replaceAll("\r\n", "\n");
}


export function renderMirrorMessage(message: MirrorMessage): RenderedMessage | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;

	let lastToolCall = -1;
	for (let index = 0; index < message.content.length; index += 1) {
		if (message.content[index]?.type === "toolCall") lastToolCall = index;
	}

	const blocks: string[] = [];
	for (let index = 0; index < message.content.length; index += 1) {
		const block = message.content[index];
		if (block?.type !== "text" || typeof block.text !== "string" || index <= lastToolCall) continue;
		const text = cleanText(block.text).trim();
		if (text) blocks.push(text);
	}
	const body = blocks.join("\n\n").trim();
	return body ? { body } : undefined;
}

export class LiveMarkdownDocument {
	#messages: MirrorMessage[] = [];
	#liveAssistant: MirrorMessage | undefined;

	reset(messages: readonly MirrorMessage[]): void {
		this.#messages = messages.filter(message => message.role === "assistant");
		this.#liveAssistant = undefined;
	}

	updateAssistant(message: MirrorMessage): void {
		this.#liveAssistant = message.role === "assistant" ? message : undefined;
	}

	finishAssistant(message: MirrorMessage): void {
		const finalMessage = message.role === "assistant" ? message : this.#liveAssistant;
		if (finalMessage) this.#messages.push(finalMessage);
		this.#liveAssistant = undefined;
	}

	hasContent(): boolean {
		if (this.#messages.some(message => renderMirrorMessage(message))) return true;
		return Boolean(this.#liveAssistant && renderMirrorMessage(this.#liveAssistant));
	}

	render(metadata: LiveMarkdownMetadata): string {
		const sections: string[] = [];
		for (const message of this.#messages) {
			const rendered = renderMirrorMessage(message);
			if (rendered) sections.push(rendered.body);
		}
		if (this.#liveAssistant) {
			const rendered = renderMirrorMessage(this.#liveAssistant);
			if (rendered) sections.push(rendered.body);
		}
		const paneLine = metadata.pane ? `\n- **Pane:** ${metadata.pane}` : "";
		return [
			"---",
			"omp_live_markdown: true",
			`repository: ${JSON.stringify(metadata.repository)}`,
			`session_id: ${JSON.stringify(metadata.sessionId)}`,
			`status: ${metadata.generating ? "generating" : "idle"}`,
			`updated_at: ${JSON.stringify(metadata.updatedAt.toISOString())}`,
			"---",
			"",
			`# ${cleanText(metadata.repository)} · ${cleanText(metadata.sessionId)}`,
			"",
			`- **Repositorio:** ${metadata.repository}`,
			`- **Ruta:** \`${cleanText(metadata.cwd)}\``,
			`- **Estado:** ${metadata.generating ? "Generando" : "En espera"}${paneLine}`,
			"",
			"---",
			"",
			sections.join("\n\n---\n\n"),
			"",
		].join("\n");
	}
}

export function sanitizeFileSegment(value: string, fallback: string): string {
	const sanitized = value
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/[. ]+$/g, "")
		.trim();
	return (sanitized || fallback).slice(0, 80);
}

function isInside(root: string, candidate: string): string | undefined {
	const relative = win32.relative(win32.resolve(root), win32.resolve(candidate));
	if (!relative || relative === ".") return "_root";
	if (win32.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${win32.sep}`)) return undefined;
	return relative;
}

export function repositoryMirrorDirectory(
	cwd: string,
	outputRoot = DEFAULT_LIVE_MARKDOWN_ROOT,
	devRoot = DEFAULT_DEV_ROOT,
): string {
	const relative = isInside(devRoot, cwd);
	if (relative) return win32.join(outputRoot, relative);
	const basename = sanitizeFileSegment(win32.basename(win32.resolve(cwd)), "repo");
	const digest = createHash("sha256").update(win32.resolve(cwd).toLowerCase()).digest("hex").slice(0, 8);
	return win32.join(outputRoot, "_externos", `${basename}--${digest}`);
}

function twoDigits(value: number): string {
	return String(value).padStart(2, "0");
}

function sessionFileId(sessionId: string): string {
	const value = sessionId.trim();
	return value ? encodeURIComponent(value).replaceAll("*", "%2A") : "sin-id";
}

export function sessionMarkdownPath(options: {
	cwd: string;
	sessionId: string;
	pane?: string;
	startedAt: Date;
	outputRoot?: string;
	devRoot?: string;
}): string {
	const { startedAt } = options;
	const day = `${startedAt.getFullYear()}-${twoDigits(startedAt.getMonth() + 1)}-${twoDigits(startedAt.getDate())}`;
	const time = `${twoDigits(startedAt.getHours())}-${twoDigits(startedAt.getMinutes())}`;
	const label = sanitizeFileSegment(options.pane ? `pane ${options.pane}` : "sesión", "sesión");
	const id = sessionFileId(options.sessionId);
	return win32.join(
		repositoryMirrorDirectory(options.cwd, options.outputRoot, options.devRoot),
		day,
		`${time} - ${label} - ${id}.md`,
	);
}
