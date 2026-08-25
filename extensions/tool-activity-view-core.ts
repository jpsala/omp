export type FilteredTranscriptRole = "user" | "assistant";

export interface FilteredTranscriptBlock {
	role: FilteredTranscriptRole;
	text: string;
}
export type FilteredViewKey =
	| "escape"
	| "q"
	| "toggle"
	| "up"
	| "down"
	| "pageUp"
	| "pageDown"
	| "home"
	| "end";

const VIEW_KEY_SEQUENCES: Record<Exclude<FilteredViewKey, "q" | "toggle">, readonly string[]> = {
	escape: ["\x1b", "\x1b[27u", "\x1b[27;1u"],
	up: ["\x1b[A", "\x1b[1;1A"],
	down: ["\x1b[B", "\x1b[1;1B"],
	pageUp: ["\x1b[5~", "\x1b[5;1~"],
	pageDown: ["\x1b[6~", "\x1b[6;1~"],
	home: ["\x1b[H", "\x1b[1~", "\x1b[1;1H"],
	end: ["\x1b[F", "\x1b[4~", "\x1b[1;1F"],
};

export function matchesFilteredViewKey(data: string, key: FilteredViewKey): boolean {
	if (key === "q") return data === "q" || data === "\x1b[113u" || data === "\x1b[113;1u";
	if (key === "toggle") return /^\x1b\[111;7(?::[123])?u$/.test(data);
	return VIEW_KEY_SEQUENCES[key].includes(data);
}

export function wrapFilteredViewText(text: string, width: number): string[] {
	const safeWidth = Math.max(1, Math.trunc(width));
	if (!text) return [""];
	const lines: string[] = [];
	let line = "";
	let lineWidth = 0;
	for (const character of text) {
		const characterWidth = Bun.stringWidth(character);
		if (line && lineWidth + characterWidth > safeWidth) {
			lines.push(line);
			line = "";
			lineWidth = 0;
		}
		line += character;
		lineWidth += characterWidth;
	}
	if (line || lines.length === 0) lines.push(line);
	return lines;
}

function safeTranscriptText(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}

function userContentText(content: unknown): string {
	if (typeof content === "string") return safeTranscriptText(content);
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const item = part as { type?: unknown; text?: unknown };
		if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
	}
	return safeTranscriptText(parts.join("\n\n"));
}

function assistantConversationText(content: unknown, stopReason: unknown): string {
	if (stopReason === "toolUse") return "";
	if (typeof content === "string") return safeTranscriptText(content);
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const item = part as { type?: unknown; text?: unknown };
		if (item.type === "toolCall") return "";
		if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
	}
	return safeTranscriptText(parts.join("\n\n"));
}

export function buildFilteredTranscript(entries: readonly unknown[]): FilteredTranscriptBlock[] {
	const blocks: FilteredTranscriptBlock[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const candidate = entry as { type?: unknown; message?: unknown };
		if (candidate.type !== "message" || typeof candidate.message !== "object" || candidate.message === null) {
			continue;
		}
		const message = candidate.message as { role?: unknown; content?: unknown; stopReason?: unknown };
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = (
			message.role === "user"
				? userContentText(message.content)
				: assistantConversationText(message.content, message.stopReason)
		).trim();
		if (!text) continue;
		blocks.push({ role: message.role, text });
	}
	return blocks;
}
