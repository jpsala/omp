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

interface AssistantMessageParts {
	answer?: RenderedMessage;
	progress: string[];
}

interface LiveMarkdownTurn {
	prompt?: MirrorMessage;
	assistantMessages: MirrorMessage[];
	progress: string[];
}

function cleanText(value: string): string {
	return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").replaceAll("\r\n", "\n");
}

function messageText(message: MirrorMessage): string | undefined {
	if (typeof message.content === "string") {
		const text = cleanText(message.content).trim();
		return text || undefined;
	}
	if (!Array.isArray(message.content)) return undefined;
	const blocks = message.content
		.filter(block => block?.type === "text" && typeof block.text === "string")
		.map(block => cleanText(block.text ?? "").trim())
		.filter(Boolean);
	const body = blocks.join("\n\n").trim();
	return body || undefined;
}


function pushUnique(values: string[], value: string): void {
	const compact = cleanText(value).replace(/\s+/g, " ").trim();
	if (compact && values.at(-1) !== compact) values.push(compact);
}

function splitAssistantMessage(message: MirrorMessage): AssistantMessageParts {
	if (message.role !== "assistant") return { progress: [] };
	if (typeof message.content === "string") {
		const body = messageText(message);
		return { answer: body ? { body } : undefined, progress: [] };
	}
	if (!Array.isArray(message.content)) return { progress: [] };

	let lastToolCall = -1;
	for (let index = 0; index < message.content.length; index += 1) {
		if (message.content[index]?.type === "toolCall") lastToolCall = index;
	}

	const answerBlocks: string[] = [];
	const progress: string[] = [];
	for (let index = 0; index < message.content.length; index += 1) {
		const block = message.content[index];
		if (block?.type !== "text" || typeof block.text !== "string") continue;
		const text = cleanText(block.text).trim();
		if (!text) continue;
		if (lastToolCall >= 0 && index <= lastToolCall) pushUnique(progress, text);
		else answerBlocks.push(text);
	}
	const body = answerBlocks.join("\n\n").trim();
	return { answer: body ? { body } : undefined, progress };
}

function renderPrompt(message: MirrorMessage | undefined): string | undefined {
	if (message?.role !== "user") return undefined;
	const body = messageText(message);
	if (!body) return "> **Vos:** _(mensaje sin texto; adjuntos no incluidos)_";
	const lines = body.split("\n");
	return lines
		.map((line, index) => {
			if (index === 0) return `> **Vos:** ${line}`;
			return line ? `> ${line}` : ">";
		})
		.join("\n");
}

export function renderMirrorMessage(message: MirrorMessage): RenderedMessage | undefined {
	return splitAssistantMessage(message).answer;
}

export class LiveMarkdownDocument {
	#turns: LiveMarkdownTurn[] = [];
	#liveAssistant: MirrorMessage | undefined;

	reset(messages: readonly MirrorMessage[]): void {
		this.#turns = [];
		this.#liveAssistant = undefined;
		for (const message of messages) {
			if (message.role === "user") this.startUser(message);
			else if (message.role === "assistant") this.#ensureTurn().assistantMessages.push(message);
		}
	}

	startUser(message: MirrorMessage): void {
		if (message.role !== "user") return;
		this.#turns.push({ prompt: message, assistantMessages: [], progress: [] });
		this.#liveAssistant = undefined;
	}

	addProgress(value: string): void {
		pushUnique(this.#ensureTurn().progress, value);
	}

	updateAssistant(message: MirrorMessage): void {
		this.#liveAssistant = message.role === "assistant" ? message : undefined;
	}

	finishAssistant(message: MirrorMessage): void {
		const finalMessage = message.role === "assistant" ? message : this.#liveAssistant;
		if (finalMessage) this.#ensureTurn().assistantMessages.push(finalMessage);
		this.#liveAssistant = undefined;
	}

	hasContent(): boolean {
		if (this.#turns.some(turn => turn.prompt || turn.assistantMessages.some(renderMirrorMessage))) return true;
		return Boolean(this.#liveAssistant && renderMirrorMessage(this.#liveAssistant));
	}

	render(metadata: LiveMarkdownMetadata): string {
		const sections: string[] = [];
		for (let index = 0; index < this.#turns.length; index += 1) {
			const turn = this.#turns[index];
			if (!turn) continue;
			const prompt = renderPrompt(turn.prompt);
			const answers: string[] = [];
			const progress: string[] = [...turn.progress];
			for (const message of turn.assistantMessages) {
				const parts = splitAssistantMessage(message);
				for (const item of parts.progress) pushUnique(progress, item);
				if (parts.answer) answers.push(parts.answer.body);
			}
			if (index === this.#turns.length - 1 && this.#liveAssistant) {
				const parts = splitAssistantMessage(this.#liveAssistant);
				for (const item of parts.progress) pushUnique(progress, item);
				if (parts.answer) answers.push(parts.answer.body);
			}

			const content: string[] = [];
			if (prompt) content.push(prompt);
			if (metadata.generating && answers.length === 0) {
				content.push(`> **En curso:** ${progress.length > 0 ? progress.join(" → ") : "Trabajando…"}`);
			}
			content.push(...answers);
			if (content.length > 0) sections.push(content.join("\n\n"));
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

	#ensureTurn(): LiveMarkdownTurn {
		const current = this.#turns.at(-1);
		if (current) return current;
		const turn: LiveMarkdownTurn = { assistantMessages: [], progress: [] };
		this.#turns.push(turn);
		return turn;
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
	const value = sessionId.trim() || "sin-id";
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function sessionMarkdownPath(options: {
	cwd: string;
	sessionId: string;
	pane?: string;
	title?: string;
	startedAt: Date;
	outputRoot?: string;
	devRoot?: string;
}): string {
	const { startedAt } = options;
	const day = `${startedAt.getFullYear()}-${twoDigits(startedAt.getMonth() + 1)}-${twoDigits(startedAt.getDate())}`;
	const time = `${twoDigits(startedAt.getHours())}-${twoDigits(startedAt.getMinutes())}`;
	const title = sanitizeFileSegment(options.title ?? "", "Sesión");
	const pane = sanitizeFileSegment(options.pane ? `p${options.pane}` : "sin pane", "sin pane");
	const id = sessionFileId(options.sessionId);
	return win32.join(
		repositoryMirrorDirectory(options.cwd, options.outputRoot, options.devRoot),
		day,
		`${time} - ${title} - ${pane} - ${id}.md`,
	);
}
