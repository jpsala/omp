import { expect, test } from "bun:test";
import {
	buildTranscriptVisibilityChoices,
	toggleTranscriptVisibilityChoice,
	type TranscriptVisibilityState,
} from "../extensions/tool-activity-view-core.ts";

const visible: TranscriptVisibilityState = {
	hideThinking: false,
	hideToolActivity: false,
	hideAssistantToolPreambles: false,
	hiddenTools: [],
};

test("builds stable granular choices from configured tools", () => {
	const choices = buildTranscriptVisibilityChoices(visible, ["read", "bash", "read", " Bash "]);
	expect(choices.map(choice => choice.id)).toEqual([
		"done",
		"thinking",
		"preambles",
		"all-tools",
		"tool:bash",
		"tool:read",
	]);
	expect(choices.find(choice => choice.id === "tool:bash")?.label).toBe("[ ] Ocultar tool · bash");
});

test("toggles independent transcript categories without changing the others", () => {
	const thinkingHidden = toggleTranscriptVisibilityChoice(visible, "thinking");
	const preamblesHidden = toggleTranscriptVisibilityChoice(thinkingHidden, "preambles");
	const bashHidden = toggleTranscriptVisibilityChoice(preamblesHidden, "tool:bash");

	expect(bashHidden).toEqual({
		hideThinking: true,
		hideToolActivity: false,
		hideAssistantToolPreambles: true,
		hiddenTools: ["bash"],
	});
	expect(toggleTranscriptVisibilityChoice(bashHidden, "tool:bash").hiddenTools).toEqual([]);
	expect(toggleTranscriptVisibilityChoice(bashHidden, "all-tools").hideToolActivity).toBe(true);
});

test("normalizes persisted hidden tool names", () => {
	const choices = buildTranscriptVisibilityChoices(
		{ ...visible, hiddenTools: [" Bash ", "READ"] },
		["bash", "read"],
	);
	expect(choices.find(choice => choice.id === "tool:bash")?.label).toBe("[x] Ocultar tool · bash");
	expect(choices.find(choice => choice.id === "tool:read")?.label).toBe("[x] Ocultar tool · read");
});
