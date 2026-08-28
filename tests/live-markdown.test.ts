import { expect, test } from "bun:test";
import {
	LiveMarkdownDocument,
	renderMirrorMessage,
	repositoryMirrorDirectory,
	sessionMarkdownPath,
} from "../extensions/live-markdown-core.ts";

test("maps repositories under C dev into a centralized familiar tree", () => {
	expect(repositoryMirrorDirectory("C:\\dev\\omp")).toBe("C:\\dev\\omp-live\\omp");
	expect(repositoryMirrorDirectory("C:\\dev\\clientes\\portal")).toBe(
		"C:\\dev\\omp-live\\clientes\\portal",
	);
	const external = repositoryMirrorDirectory("D:\\work\\portal");
	expect(external).toMatch(/^C:\\dev\\omp-live\\_externos\\portal--[a-f0-9]{8}$/);
});

test("creates chronological stable Markdown paths for one session", () => {
	const filePath = sessionMarkdownPath({
		cwd: "C:\\dev\\omp",
		sessionId: "12345678-abcd-ef00",
		sessionName: "Diseño: streaming / Markdown",
		pane: "2",
		startedAt: new Date(2026, 7, 28, 15, 7),
	});
	expect(filePath).toBe(
		"C:\\dev\\omp-live\\omp\\2026-08-28\\15-07 - Diseño streaming Markdown - 12345678-abc.md",
	);
});

test("renders assistant thinking and prose without tool payloads", () => {
	const rendered = renderMirrorMessage({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Checking the contract\nbefore editing" },
			{ type: "toolCall", text: "must not leak" },
			{ type: "text", text: "## Resultado\n\nTexto **útil**." },
		],
	});
	expect(rendered).toEqual({
		role: "assistant",
		body: [
			"> **Pensando**",
			">",
			"> Checking the contract",
			"> before editing",
			"",
			"## Resultado",
			"",
			"Texto **útil**.",
		].join("\n"),
	});
});

test("replaces the live assistant snapshot and finalizes it once", () => {
	const document = new LiveMarkdownDocument();
	document.reset([{ role: "user", content: [{ type: "text", text: "Probemos esto" }] }]);
	document.updateAssistant({ role: "assistant", content: [{ type: "text", text: "Primera" }] });
	document.updateAssistant({ role: "assistant", content: [{ type: "text", text: "Primera versión ampliada" }] });

	const live = document.render({
		repository: "omp",
		cwd: "C:\\dev\\omp",
		sessionId: "session-1",
		sessionName: "Espejo Markdown",
		pane: "2",
		generating: true,
		updatedAt: new Date("2026-08-28T15:07:00.000Z"),
	});
	expect(live).toContain("status: generating");
	expect(live).toContain("## Vos\n\nProbemos esto");
	expect(live).toContain("## Agente\n\nPrimera versión ampliada");
	expect(live).not.toContain("## Agente\n\nPrimera\n");

	document.finishAssistant({
		role: "assistant",
		content: [{ type: "text", text: "Primera versión final" }],
	});
	const final = document.render({
		repository: "omp",
		cwd: "C:\\dev\\omp",
		sessionId: "session-1",
		sessionName: "Espejo Markdown",
		generating: false,
		updatedAt: new Date("2026-08-28T15:08:00.000Z"),
	});
	expect(final).toContain("status: idle");
	expect(final.match(/## Agente/g)).toHaveLength(1);
	expect(final).toContain("Primera versión final");
});
