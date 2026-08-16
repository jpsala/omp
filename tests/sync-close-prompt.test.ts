import { expect, test } from "bun:test";
import syncClosePrompt, {
	buildSyncClosePrompt,
	SYNC_CLOSE_COMMAND,
} from "../extensions/sync-close-prompt.ts";

test("builds the canonical guarded close prompt", () => {
	const prompt = buildSyncClosePrompt("");

	expect(prompt).toContain("C:/dev/infra/docs/runbooks/sync-multi-repo.md");
	expect(prompt.match(/bun run sync:audit/g)).toHaveLength(2);
	expect(prompt).toContain("nunca uses git add -A");
	expect(prompt).toContain("no autoriza merge/rebase a main, release, deploy");
	expect(prompt).toContain("worktrees aislados");
	expect(prompt).toContain("igual a su upstream publicado");
});

test("encodes optional focus as a quoted user value", () => {
	const prompt = buildSyncClosePrompt('reservas\n"públicas"');

	expect(prompt).toContain('Foco adicional provisto por JP (JSON string): "reservas\\n\\"públicas\\""');
	expect(prompt).not.toContain("reservas\n\"públicas\"\n\n1.");
});

test("registers an interactive command that preloads without sending", async () => {
	let registeredName = "";
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const sent: string[] = [];
	const api = {
		registerCommand(name: string, options: { handler: typeof handler }) {
			registeredName = name;
			handler = options.handler;
		},
		sendUserMessage(content: string) {
			sent.push(content);
		},
	};

	syncClosePrompt(api as never);
	const inserted: string[] = [];
	await handler?.("infra", {
		hasUI: true,
		ui: { setEditorText(text: string) { inserted.push(text); } },
	});

	expect(registeredName).toBe(SYNC_CLOSE_COMMAND);
	expect(inserted).toHaveLength(1);
	expect(inserted[0]).toBe(buildSyncClosePrompt("infra"));
	expect(sent).toEqual([]);
});

test("does nothing outside interactive UI", async () => {
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const api = {
		registerCommand(_name: string, options: { handler: typeof handler }) {
			handler = options.handler;
		},
	};

	syncClosePrompt(api as never);
	let inserted = false;
	await handler?.("", {
		hasUI: false,
		ui: { setEditorText() { inserted = true; } },
	});

	expect(inserted).toBe(false);
});
