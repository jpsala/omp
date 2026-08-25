export type FilteredTranscriptRole = "user" | "assistant";

export interface FilteredTranscriptBlock {
	role: FilteredTranscriptRole;
	text: string;
}

function safeTranscriptText(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}

function contentText(content: unknown): string {
	if (typeof content === "string") return safeTranscriptText(content);
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const item = part as { type?: unknown; text?: unknown; thinking?: unknown };
		if (item.type === "text" && typeof item.text === "string") {
			parts.push(item.text);
		} else if (item.type === "thinking" && typeof item.thinking === "string") {
			parts.push(item.thinking);
		}
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
		const message = candidate.message as { role?: unknown; content?: unknown };
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = contentText(message.content).trim();
		if (!text) continue;
		blocks.push({ role: message.role, text });
	}
	return blocks;
}
