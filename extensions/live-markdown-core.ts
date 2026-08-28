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
	sessionName: string;
	pane?: string;
	generating: boolean;
	updatedAt: Date;
}

interface RenderedMessage {
	role: "user" | "assistant";
	body: string;
}

function cleanText(value: string): string {
	return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").replaceAll("\r\n", "\n");
}

function textBlocks(message: MirrorMessage): string[] {
	if (typeof message.content === "string") return [cleanText(message.content)];
	if (!Array.isArray(message.content)) return [];
	return message.content
		.filter(block => block?.type === "text" && typeof block.text === "string")
		.map(block => cleanText(block.text!));
}

function quoteThinking(value: string): string {
	const lines = cleanText(value).trim().split("\n");
	if (lines.length === 0 || (lines.length === 1 && !lines[0])) return "";
	return ["> **Pensando**", ">", ...lines.map(line => `> ${line}`)].join("\n");
}

export function renderMirrorMessage(message: MirrorMessage): RenderedMessage | undefined {
	if (message.role === "user") {
		const body = textBlocks(message).join("\n\n").trim();
		return body ? { role: "user", body } : undefined;
	}
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;

	const blocks: string[] = [];
	for (const block of message.content) {
		if (block?.type === "thinking" && typeof block.thinking === "string") {
			const thinking = quoteThinking(block.thinking);
			if (thinking) blocks.push(thinking);
		} else if (block?.type === "text" && typeof block.text === "string") {
			const text = cleanText(block.text).trim();
			if (text) blocks.push(text);
		}
	}
	const body = blocks.join("\n\n").trim();
	return body ? { role: "assistant", body } : undefined;
}

export class LiveMarkdownDocument {
	#messages: RenderedMessage[] = [];
	#liveAssistant: RenderedMessage | undefined;

	reset(messages: readonly MirrorMessage[]): void {
		this.#messages = messages.map(renderMirrorMessage).filter((message): message is RenderedMessage => Boolean(message));
		this.#liveAssistant = undefined;
	}

	appendUser(message: MirrorMessage): void {
		const rendered = renderMirrorMessage(message);
		if (rendered?.role === "user") this.#messages.push(rendered);
	}

	updateAssistant(message: MirrorMessage): void {
		const rendered = renderMirrorMessage(message);
		this.#liveAssistant = rendered?.role === "assistant" ? rendered : undefined;
	}

	finishAssistant(message: MirrorMessage): void {
		const rendered = renderMirrorMessage(message) ?? this.#liveAssistant;
		if (rendered?.role === "assistant") this.#messages.push(rendered);
		this.#liveAssistant = undefined;
	}

	render(metadata: LiveMarkdownMetadata): string {
		const messages = this.#liveAssistant ? [...this.#messages, this.#liveAssistant] : this.#messages;
		const sections = messages.map(message => `## ${message.role === "user" ? "Vos" : "Agente"}\n\n${message.body}`);
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
			`# ${cleanText(metadata.sessionName)}`,
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

export function sessionMarkdownPath(options: {
	cwd: string;
	sessionId: string;
	sessionName?: string;
	pane?: string;
	startedAt: Date;
	outputRoot?: string;
	devRoot?: string;
}): string {
	const { startedAt } = options;
	const day = `${startedAt.getFullYear()}-${twoDigits(startedAt.getMonth() + 1)}-${twoDigits(startedAt.getDate())}`;
	const time = `${twoDigits(startedAt.getHours())}-${twoDigits(startedAt.getMinutes())}`;
	const label = sanitizeFileSegment(options.sessionName || (options.pane ? `pane ${options.pane}` : "sesión"), "sesión");
	const id = sanitizeFileSegment(options.sessionId, "sin-id").slice(0, 12);
	return win32.join(
		repositoryMirrorDirectory(options.cwd, options.outputRoot, options.devRoot),
		day,
		`${time} - ${label} - ${id}.md`,
	);
}
