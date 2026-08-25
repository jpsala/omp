import { expect, test } from "bun:test";
import {
	buildFilteredTranscript,
	matchesFilteredViewKey,
	wrapFilteredViewText,
} from "../extensions/tool-activity-view-core.ts";

test("keeps conversation text and removes tool activity", () => {
	const transcript = buildFilteredTranscript([
		{ type: "message", message: { role: "user", content: "revisá el repo" } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Voy a inspeccionarlo." },
					{ type: "toolCall", name: "bash", arguments: { command: "git status" } },
					{ type: "text", text: "El árbol está limpio." },
				],
			},
		},
		{
			type: "message",
			message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "secret output" }] },
		},
	]);

	expect(transcript).toEqual([
		{ role: "user", text: "revisá el repo" },
		{ role: "assistant", text: "Voy a inspeccionarlo.\n\nEl árbol está limpio." },
	]);
	expect(JSON.stringify(transcript)).not.toContain("git status");
	expect(JSON.stringify(transcript)).not.toContain("secret output");
});

test("strips terminal control bytes from transcript text", () => {
	const transcript = buildFilteredTranscript([
		{ type: "message", message: { role: "assistant", content: "safe\u001b[2Jtext\u0007" } },
	]);

	expect(transcript).toEqual([{ role: "assistant", text: "safe[2Jtext" }]);
});

test("recognizes the reversible view keys without conflating Enter", () => {
	expect(matchesFilteredViewKey("\u001b[109;6u", "toggle")).toBe(true);
	expect(matchesFilteredViewKey("\r", "toggle")).toBe(false);
	expect(matchesFilteredViewKey("\u001b", "escape")).toBe(true);
});

test("wraps filtered prose to terminal cell width", () => {
	expect(wrapFilteredViewText("abcd", 3)).toEqual(["abc", "d"]);
	expect(wrapFilteredViewText("界a", 2)).toEqual(["界", "a"]);
});

