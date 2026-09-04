import type {
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { expect, test } from "bun:test";
import liveMarkdown from "../extensions/live-markdown.ts";
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

test("creates chronological paths with the complete session identity", () => {
	const filePath = sessionMarkdownPath({
		cwd: "C:\\dev\\omp",
		sessionId: "12345678-abcd-ef00",
		pane: "2",
		startedAt: new Date(2026, 7, 28, 15, 7),
	});
	expect(filePath).toBe(
		"C:\\dev\\omp-live\\omp\\2026-08-28\\15-07 - pane 2 - 12345678-abcd-ef00.md",
	);

	const concurrentPath = sessionMarkdownPath({
		cwd: "C:\\dev\\omp",
		sessionId: "12345678-abcd-ef01",
		pane: "2",
		startedAt: new Date(2026, 7, 28, 15, 7),
	});
	expect(concurrentPath).not.toBe(filePath);
});

test("creates a clean session file and refreshes its activity directories", async () => {
	type EventHandler = (event: unknown, ctx: ExtensionContext) => void;
	const handlers = new Map<string, EventHandler>();
	let writtenPath = "";
	let writtenContent = "";
	const touchedDirectories: string[] = [];
	let resolveWrite: (() => void) | undefined;
	const writeComplete = new Promise<void>(resolve => {
		resolveWrite = resolve;
	});
	let resolveActivity: (() => void) | undefined;
	const activityComplete = new Promise<void>(resolve => {
		resolveActivity = resolve;
	});
	const testApi = {
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, handler);
		},
		registerCommand: () => {},
		logger: { error: () => {} },
	};
	liveMarkdown(testApi as unknown as ExtensionAPI, {
		interactive: true,
		outputRoot: "C:\\mirror",
		ensureDirectory: async () => {},
		writeSnapshot: async (path, content) => {
			writtenPath = path;
			writtenContent = content;
			resolveWrite?.();
		},
		touchDirectory: async path => {
			touchedDirectories.push(path);
			if (touchedDirectories.length === 2) resolveActivity?.();
		},
	});

	const timestamp = "2026-09-03T08:40:11.934";
	const ctx = {
		cwd: "C:\\dev\\omp",
		hasUI: true,
		sessionManager: {
			getSessionId: () => "session-empty",
			getHeader: () => ({ timestamp }),
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
	handlers.get("session_start")?.({}, ctx);
	await Promise.all([writeComplete, activityComplete]);

	expect(writtenPath).toContain("C:\\mirror\\omp\\2026-09-03\\08-40");
	expect(writtenContent).toContain('session_id: "session-empty"');
	expect(writtenContent).toContain("status: idle");
	expect(writtenContent).not.toContain("## Agente");
	expect(touchedDirectories).toEqual(["C:\\mirror\\omp\\2026-09-03", "C:\\mirror\\omp"]);
});

test("does not publish RPC or headless sessions", () => {
	type EventHandler = (event: unknown, ctx: ExtensionContext) => void;
	const handlers = new Map<string, EventHandler>();
	let writes = 0;
	const testApi = {
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, handler);
		},
		registerCommand: () => {},
		logger: { error: () => {} },
	};
	liveMarkdown(testApi as unknown as ExtensionAPI, {
		interactive: false,
		ensureDirectory: async () => {},
		writeSnapshot: async () => {
			writes += 1;
		},
	});

	const ctx = {
		cwd: "C:\\dev\\omp",
		hasUI: true,
		sessionManager: {
			getSessionId: () => "rpc-session",
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
	handlers.get("session_start")?.({}, ctx);
	expect(writes).toBe(0);
});

test("defaults to assistant-only output without internal activity", () => {
	expect(renderMirrorMessage({ role: "user", content: [{ type: "text", text: "private prompt" }] })).toBeUndefined();
	const rendered = renderMirrorMessage({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "private reasoning" },
			{ type: "text", text: "internal preamble" },
			{ type: "toolCall", text: "private tool payload" },
			{ type: "text", text: "Final answer" },
		],
	});
	expect(rendered).toEqual({ body: "Final answer" });
});

test("keeps the reading mirror clean regardless of transcript visibility", () => {
	const rendered = renderMirrorMessage({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Checking the contract\nbefore editing" },
			{ type: "text", text: "Internal preamble" },
			{ type: "toolCall", text: "must not leak" },
			{ type: "text", text: "## Resultado\n\nTexto **útil**." },
		],
	});
	expect(rendered).toEqual({
		body: "## Resultado\n\nTexto **útil**.",
	});
});

test("drops operational-only messages and repeated agent wrappers", () => {
	const document = new LiveMarkdownDocument();
	document.reset([
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Reviewing git status before commit" },
				{ type: "text", text: "Preparing commit" },
				{ type: "toolCall", text: "git status" },
			],
		},
		{ role: "assistant", content: [{ type: "thinking", thinking: "Planning checks" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Running checks" },
				{ type: "toolCall", text: "bun test" },
				{ type: "text", text: "Cambio listo y verificado." },
			],
		},
	]);

	const rendered = document.render({
		repository: "omp",
		cwd: "C:\\dev\\omp",
		sessionId: "session-clean",
		generating: false,
		updatedAt: new Date("2026-09-03T12:00:00.000Z"),
	});
	expect(rendered).toContain("Cambio listo y verificado.");
	expect(rendered).not.toContain("Reviewing git status");
	expect(rendered).not.toContain("Preparing commit");
	expect(rendered).not.toContain("Planning checks");
	expect(rendered).not.toContain("Running checks");
	expect(rendered).not.toContain("## Agente");
});

test("replaces the live assistant snapshot, includes the prompt, and finalizes once", () => {
	const document = new LiveMarkdownDocument();
	document.reset([{ role: "user", content: [{ type: "text", text: "Probemos esto" }] }]);
	document.updateAssistant({ role: "assistant", content: [{ type: "text", text: "Primera" }] });
	document.updateAssistant({ role: "assistant", content: [{ type: "text", text: "Primera versión ampliada" }] });

	const live = document.render({
		repository: "omp",
		cwd: "C:\\dev\\omp",
		sessionId: "session-1",
		pane: "2",
		generating: true,
		updatedAt: new Date("2026-08-28T15:07:00.000Z"),
	});
	expect(live).toContain("status: generating");
	expect(live).toContain("> **Vos:** Probemos esto");
	expect(live).toContain("Primera versión ampliada");
	expect(live).not.toContain("## Agente");

	document.finishAssistant({
		role: "assistant",
		content: [{ type: "text", text: "Primera versión final" }],
	});
	const final = document.render({
		repository: "omp",
		cwd: "C:\\dev\\omp",
		sessionId: "session-1",
		generating: false,
		updatedAt: new Date("2026-08-28T15:08:00.000Z"),
	});
	expect(final).toContain("status: idle");
	expect(final).toContain("> **Vos:** Probemos esto");
	expect(final).not.toContain("## Agente");
	expect(final).toContain("Primera versión final");
});

test("accumulates operational activity in one transient item", () => {
	const document = new LiveMarkdownDocument();
	document.reset([{ role: "user", content: [{ type: "text", text: "Revisá el contrato" }] }]);
	document.addProgress("Localizando implementación");
	document.updateAssistant({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "private reasoning" },
			{ type: "text", text: "Leyendo eventos oficiales" },
			{ type: "toolCall", text: "private tool payload" },
		],
	});

	const working = document.render({
		repository: "omp",
		cwd: "C:\\dev\\omp",
		sessionId: "session-progress",
		generating: true,
		updatedAt: new Date("2026-09-03T12:00:00.000Z"),
	});
	expect(working.match(/\*\*En curso:\*\*/g)).toHaveLength(1);
	expect(working).toContain("Localizando implementación → Leyendo eventos oficiales");
	expect(working).not.toContain("private reasoning");
	expect(working).not.toContain("private tool payload");

	document.finishAssistant({
		role: "assistant",
		content: [
			{ type: "text", text: "Leyendo eventos oficiales" },
			{ type: "toolCall", text: "private tool payload" },
		],
	});
	document.addProgress("Comparando alternativas");
	document.updateAssistant({
		role: "assistant",
		content: [{ type: "text", text: "El contrato final conserva Markdown." }],
	});
	const answering = document.render({
		repository: "omp",
		cwd: "C:\\dev\\omp",
		sessionId: "session-progress",
		generating: true,
		updatedAt: new Date("2026-09-03T12:01:00.000Z"),
	});
	expect(answering).not.toContain("**En curso:**");
	expect(answering).toContain("El contrato final conserva Markdown.");

	document.finishAssistant({
		role: "assistant",
		content: [{ type: "text", text: "El contrato final queda limpio." }],
	});
	const final = document.render({
		repository: "omp",
		cwd: "C:\\dev\\omp",
		sessionId: "session-progress",
		generating: false,
		updatedAt: new Date("2026-09-03T12:02:00.000Z"),
	});
	expect(final).not.toContain("**En curso:**");
	expect(final).not.toContain("Localizando implementación");
	expect(final).toContain("El contrato final queda limpio.");
});

test("reconstructs prompts and answers as chronological turns", () => {
	const document = new LiveMarkdownDocument();
	document.reset([
		{ role: "user", content: [{ type: "text", text: "Primera pregunta" }] },
		{ role: "assistant", content: [{ type: "text", text: "Primera respuesta" }] },
		{ role: "user", content: [{ type: "text", text: "Segunda pregunta" }] },
		{ role: "assistant", content: [{ type: "text", text: "Segunda respuesta" }] },
	]);
	const rendered = document.render({
		repository: "omp",
		cwd: "C:\\dev\\omp",
		sessionId: "session-history",
		generating: false,
		updatedAt: new Date("2026-09-03T12:03:00.000Z"),
	});
	const firstPrompt = rendered.indexOf("Primera pregunta");
	const firstAnswer = rendered.indexOf("Primera respuesta");
	const secondPrompt = rendered.indexOf("Segunda pregunta");
	const secondAnswer = rendered.indexOf("Segunda respuesta");
	expect(firstPrompt).toBeGreaterThan(-1);
	expect(firstAnswer).toBeGreaterThan(firstPrompt);
	expect(secondPrompt).toBeGreaterThan(firstAnswer);
	expect(secondAnswer).toBeGreaterThan(secondPrompt);
});
