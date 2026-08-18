/**
 * Windows-like input editor for OMP.
 * Windows/VS Code-style selection semantics over OMP's native editor.
 *
 * This file is the durable source; the installed wrapper re-exports it.
 *
 * The extension delegates rendering to `CustomEditor`, preserving slash/file/
 * skill autocomplete, and adds selection highlighting through `decorateText`.
 *
 * Load/reload: restart OMP or run `/reload` after updating this source.
 * Toggle: `/windows-input on|off|toggle|status`.
 * Model selection stays on OMP's native model hub and keybindings.
 */

import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	decodePrintableKey,
	type EditorTheme,
	type KeybindingsManager,
	matchesKey,
	type TUI,
} from "@oh-my-pi/pi-tui";

type Pos = { line: number; col: number };
type Range = { start: Pos; end: Pos };

function comparePos(a: Pos, b: Pos): number {
	if (a.line !== b.line) return a.line - b.line;
	return a.col - b.col;
}

function normalizeText(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\t/g, "    ");
}

export function normalizeWindowsDrivePathsForBash(command: string): string {
	if (platform() !== "win32") return command;

	const normalizePath = (path: string) => path.replace(/\\/g, "/");
	const quoted = command.replace(
		/(["'])([A-Za-z]:\\[^"'`\r\n]*)\1/g,
		(_match, quote, path) => {
			return `${quote}${normalizePath(path)}${quote}`;
		},
	);

	return quoted.replace(/\b[A-Za-z]:\\[^\s"'`|;&<>]*/g, normalizePath);
}

function stripBracketedPaste(data: string): string | undefined {
	const startMarker = "\x1b[200~";
	const start = data.indexOf(startMarker);
	if (start < 0) return undefined;
	const contentStart = start + startMarker.length;
	const end = data.indexOf("\x1b[201~", contentStart);
	return data.slice(contentStart, end < 0 ? undefined : end);
}

function copyText(text: string): void {
	try {
		const p = platform();
		if (p === "win32") {
			spawnSync("clip", {
				input: text,
				shell: true,
				stdio: ["pipe", "ignore", "ignore"],
			});
			return;
		}
		if (p === "darwin") {
			spawnSync("pbcopy", { input: text, stdio: ["pipe", "ignore", "ignore"] });
			return;
		}
		if (process.env.WAYLAND_DISPLAY) {
			const wl = spawnSync("wl-copy", {
				input: text,
				stdio: ["pipe", "ignore", "ignore"],
			});
			if (wl.status === 0) return;
		}
		if (process.env.DISPLAY) {
			spawnSync("xclip", ["-selection", "clipboard"], {
				input: text,
				stdio: ["pipe", "ignore", "ignore"],
			});
		}
	} catch {
		// Keep editor behavior non-fatal if clipboard tooling is unavailable.
	}
}

function readCommandStdout(
	command: string,
	args: string[],
	options: { shell?: boolean } = {},
): string | null {
	try {
		const result = spawnSync(command, args, {
			timeout: 1000,
			maxBuffer: 2 * 1024 * 1024,
			encoding: "utf8",
			shell: options.shell,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (result.status !== 0 || typeof result.stdout !== "string") return null;
		return result.stdout;
	} catch {
		return null;
	}
}

function readClipboardTextSync(): string | null {
	const p = platform();
	if (p === "win32") {
		return readCommandStdout("powershell.exe", [
			"-NoProfile",
			"-Command",
			"Get-Clipboard -Raw",
		]);
	}
	if (p === "darwin") {
		return readCommandStdout("pbpaste", []);
	}
	if (process.env.TERMUX_VERSION) {
		const termux = readCommandStdout("termux-clipboard-get", []);
		if (termux !== null) return termux;
	}
	if (process.env.WSL_DISTRO_NAME || process.env.WSLENV) {
		const powershell = readCommandStdout("powershell.exe", [
			"-NoProfile",
			"-Command",
			"Get-Clipboard -Raw",
		]);
		if (powershell !== null)
			return powershell.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	}
	if (process.env.WAYLAND_DISPLAY) {
		const wayland = readCommandStdout("wl-paste", ["--no-newline"]);
		if (wayland !== null) return wayland;
	}
	if (process.env.DISPLAY) {
		const xclip = readCommandStdout("xclip", ["-selection", "clipboard", "-o"]);
		if (xclip !== null) return xclip;
		const xsel = readCommandStdout("xsel", ["--clipboard", "--output"]);
		if (xsel !== null) return xsel;
	}
	return null;
}

class WindowsInputEditor extends CustomEditor {
	private selectionAnchor: Pos | null = null;

	private get lines(): string[] {
		return this.getLines();
	}

	private get cursor(): Pos {
		return this.getCursor();
	}

	private moveCursorTo(pos: Pos): void {
		const lines = this.lines;
		const targetLine = Math.max(0, Math.min(pos.line, lines.length - 1));
		const targetCol = Math.max(
			0,
			Math.min(pos.col, lines[targetLine]?.length ?? 0),
		);
		this.moveToMessageStart();
		for (let line = 0; line < targetLine; line++) super.handleInput("\x1b[B");
		for (let col = 0; col < targetCol; col++) super.handleInput("\x1b[C");
	}

	private docEnd(): Pos {
		const line = Math.max(0, this.lines.length - 1);
		return { line, col: this.lines[line]?.length ?? 0 };
	}

	private selectionRange(): Range | null {
		if (!this.selectionAnchor) return null;
		const focus = this.cursor;
		if (comparePos(this.selectionAnchor, focus) === 0) return null;
		return comparePos(this.selectionAnchor, focus) < 0
			? { start: { ...this.selectionAnchor }, end: focus }
			: { start: focus, end: { ...this.selectionAnchor } };
	}

	private clearSelection(): void {
		this.selectionAnchor = null;
	}

	private beginOrKeepSelection(): void {
		if (!this.selectionAnchor) this.selectionAnchor = this.cursor;
	}

	private posToOffset(pos: Pos): number {
		let offset = 0;
		for (let i = 0; i < pos.line; i++)
			offset += (this.lines[i]?.length ?? 0) + 1;
		return offset + pos.col;
	}

	private selectedText(): string {
		const range = this.selectionRange();
		if (!range) return "";
		// Use raw editor text because selection offsets are based on state.lines.
		// Expanded paste-marker text has different offsets and corrupts edits/copy ranges.
		const text = this.getText();
		return text.slice(
			this.posToOffset(range.start),
			this.posToOffset(range.end),
		);
	}

	private replaceRange(range: Range, replacement: string): void {
		// Use raw editor text because range offsets are computed from state.lines.
		// getExpandedText() expands paste markers and can desynchronize offsets.
		const currentText = this.getText();
		const startOffset = this.posToOffset(range.start);
		const endOffset = this.posToOffset(range.end);
		const normalized = normalizeText(replacement);
		const nextText =
			currentText.slice(0, startOffset) +
			normalized +
			currentText.slice(endOffset);
		const cursor = this.offsetToPosInText(
			nextText,
			startOffset + normalized.length,
		);

		this.onAutocompleteCancel?.();
		this.setText(nextText);
		this.moveCursorTo(cursor);
		this.clearSelection();
		this.notifyChanged();
	}

	private offsetToPosInText(text: string, offset: number): Pos {
		const before = text.slice(0, Math.max(0, offset));
		const parts = before.split("\n");
		return {
			line: parts.length - 1,
			col: parts[parts.length - 1]?.length ?? 0,
		};
	}

	private deleteSelection(): boolean {
		const range = this.selectionRange();
		if (!range) return false;
		this.replaceRange(range, "");
		return true;
	}

	private replaceSelection(text: string): boolean {
		const range = this.selectionRange();
		if (!range) return false;
		this.replaceRange(range, text);
		return true;
	}

	private notifyChanged(): void {
		this.onChange?.(this.getText());
		this.tui?.requestRender();
	}

	private collapseSelection(to: "start" | "end"): boolean {
		const range = this.selectionRange();
		if (!range) return false;
		this.moveCursorTo(to === "start" ? range.start : range.end);
		this.clearSelection();
		this.tui?.requestRender();
		return true;
	}

	private moveWithoutSelecting(data: string): void {
		super.handleInput(data);
		this.clearSelection();
	}

	private moveSelecting(fn: () => void): void {
		this.beginOrKeepSelection();
		fn();
		this.tui?.requestRender();
	}

	private moveVisual(delta: -1 | 1): void {
		super.handleInput(delta < 0 ? "\x1b[A" : "\x1b[B");
	}

	private selectAll(): void {
		this.selectionAnchor = { line: 0, col: 0 };
		this.moveCursorTo(this.docEnd());
		this.tui?.requestRender();
	}

	handleInput(data: string): void {
		const pasted = stripBracketedPaste(data);
		if (pasted !== undefined && this.selectionRange()) {
			this.replaceSelection(pasted);
			return;
		}

		if (matchesKey(data, "ctrl+z")) {
			this.clearSelection();
			super.handleInput(data);
			this.tui?.requestRender();
			return;
		}

		if (matchesKey(data, "ctrl+a")) {
			this.selectAll();
			return;
		}


		if (matchesKey(data, "ctrl+c")) {
			const selected = this.selectedText();
			if (selected) {
				copyText(selected);
				return;
			}
			// Preserve Pi's app.clear action when there is no selection.
			super.handleInput(data);
			return;
		}

		if (matchesKey(data, "ctrl+x")) {
			const selected = this.selectedText();
			if (selected) {
				copyText(selected);
				this.deleteSelection();
			}
			// Windows-style text boxes do nothing when Ctrl+X has no selection.
			return;
		}

		if (matchesKey(data, "ctrl+v")) {
			const clipboardText = readClipboardTextSync();
			if (clipboardText !== null && clipboardText.length > 0) {
				if (!this.replaceSelection(clipboardText))
					this.insertText(clipboardText);
				this.clearSelection();
				this.tui?.requestRender();
				return;
			}
			// If text clipboard is unavailable, preserve Pi's default Ctrl+V action
			// (Linux paste-image keybinding) or terminal-specific behavior.
			super.handleInput(data);
			return;
		}

		if (matchesKey(data, "escape") && this.selectionRange()) {
			this.clearSelection();
			this.tui?.requestRender();
			return;
		}

		if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
			if (this.deleteSelection()) return;
			super.handleInput(data);
			return;
		}

		if (matchesKey(data, "left")) {
			if (!this.collapseSelection("start")) this.moveWithoutSelecting(data);
			return;
		}
		if (matchesKey(data, "right")) {
			if (!this.collapseSelection("end")) this.moveWithoutSelecting(data);
			return;
		}
		if (
			matchesKey(data, "up") ||
			matchesKey(data, "down") ||
			matchesKey(data, "home") ||
			matchesKey(data, "end") ||
			matchesKey(data, "ctrl+left") ||
			matchesKey(data, "ctrl+right")
		) {
			this.moveWithoutSelecting(data);
			return;
		}

		if (matchesKey(data, "shift+left")) {
			this.moveSelecting(() => super.handleInput("\x1b[D"));
			return;
		}
		if (matchesKey(data, "shift+right")) {
			this.moveSelecting(() => super.handleInput("\x1b[C"));
			return;
		}
		if (matchesKey(data, "shift+up")) {
			this.moveSelecting(() => this.moveVisual(-1));
			return;
		}
		if (matchesKey(data, "shift+down")) {
			this.moveSelecting(() => this.moveVisual(1));
			return;
		}
		if (matchesKey(data, "shift+home")) {
			this.moveSelecting(() => this.moveToLineStart());
			return;
		}
		if (matchesKey(data, "shift+end")) {
			this.moveSelecting(() => this.moveToLineEnd());
			return;
		}
		if (matchesKey(data, "ctrl+shift+left")) {
			this.moveSelecting(() => super.handleInput("\x1b[1;5D"));
			return;
		}
		if (matchesKey(data, "ctrl+shift+right")) {
			this.moveSelecting(() => super.handleInput("\x1b[1;5C"));
			return;
		}
		if (matchesKey(data, "ctrl+shift+home")) {
			this.moveSelecting(() => this.moveCursorTo({ line: 0, col: 0 }));
			return;
		}
		if (matchesKey(data, "ctrl+shift+end")) {
			this.moveSelecting(() => this.moveCursorTo(this.docEnd()));
			return;
		}

		if (this.selectionRange() && this.isNewlineInsertion(data)) {
			this.replaceSelection("\n");
			return;
		}

		if (this.selectionRange() && this.isTextInsertion(data)) {
			this.replaceSelection(pasted ?? this.printableFromInput(data) ?? data);
			return;
		}

		super.handleInput(data);
		if (
			!this.isSelectionExtendingKey(data) &&
			!this.isPureModifierOrRelease(data)
		) {
			// Normal editing/navigation clears the visual selection unless handled above.
			this.clearSelection();
		}
	}

	private isSelectionExtendingKey(data: string): boolean {
		return (
			matchesKey(data, "shift+left") ||
			matchesKey(data, "shift+right") ||
			matchesKey(data, "shift+up") ||
			matchesKey(data, "shift+down") ||
			matchesKey(data, "shift+home") ||
			matchesKey(data, "shift+end") ||
			matchesKey(data, "ctrl+shift+left") ||
			matchesKey(data, "ctrl+shift+right") ||
			matchesKey(data, "ctrl+shift+home") ||
			matchesKey(data, "ctrl+shift+end")
		);
	}

	private isPureModifierOrRelease(_data: string): boolean {
		return false;
	}

	private printableFromInput(data: string): string | undefined {
		// Plain printable chars arrive as single characters in most terminals.
		if (data.length === 1 && data.charCodeAt(0) >= 32) return data;
		// Kitty CSI-u printable chars can arrive as escape sequences; base Editor
		// handles them, so selection replacement must decode them too.
		const printable = decodePrintableKey(data);
		if (printable !== undefined) return printable;
		if (matchesKey(data, "shift+space")) return " ";
		return undefined;
	}

	private isTextInsertion(data: string): boolean {
		return (
			stripBracketedPaste(data) !== undefined ||
			this.printableFromInput(data) !== undefined
		);
	}

	private isNewlineInsertion(data: string): boolean {
		return (
			matchesKey(data, "shift+enter") ||
			data === "\x1b\r" ||
			data === "\x1b[13;2~" ||
			data === "\x1b[13;2u" ||
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
			(data === "\n" && data.length === 1)
		);
	}

	override render(width: number): readonly string[] {
		const range = this.selectionRange();
		if (!range) return super.render(width);

		const source = this.getText();
		const selectionStart = this.posToOffset(range.start);
		const selectionEnd = this.posToOffset(range.end);
		let searchOffset = 0;
		const previousDecorator = this.decorateText;

		// Keep OMP's renderer—including slash/file/skill autocomplete—and add
		// selection highlighting through the editor's public decoration hook.
		// During an active selection this deliberately replaces transient prompt
		// keyword decoration; restoring it after the frame avoids mutating host state.
		this.decorateText = (segment: string): string => {
			const segmentStart = source.indexOf(segment, searchOffset);
			if (segmentStart < 0) return segment;
			const segmentEnd = segmentStart + segment.length;
			searchOffset = segmentEnd;
			const overlapStart = Math.max(selectionStart, segmentStart);
			const overlapEnd = Math.min(selectionEnd, segmentEnd);
			if (overlapStart >= overlapEnd) return segment;
			const localStart = overlapStart - segmentStart;
			const localEnd = overlapEnd - segmentStart;
			return `${segment.slice(0, localStart)}\x1b[7m${segment.slice(localStart, localEnd)}\x1b[0m${segment.slice(localEnd)}`;
		};

		try {
			return super.render(width);
		} finally {
			this.decorateText = previousDecorator;
		}
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

	const apply = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent(
			enabled
				? (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) =>
						new WindowsInputEditor(tui, theme, keybindings)
				: undefined,
		);
		ctx.ui.setStatus?.("windows-input", undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		apply(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus?.("windows-input", undefined);
	});

	pi.on("tool_call", (event) => {
		if (platform() !== "win32" || event.toolName !== "bash") return;
		const input = event.input as { command: string };
		const command = normalizeWindowsDrivePathsForBash(input.command);
		if (command === input.command) return;
		return { input: { ...input, command } };
	});

	pi.registerCommand("windows-input", {
		description: "Toggle Windows-like input editor",
		handler: (args, ctx) => {
			const action = String(args || "toggle")
				.trim()
				.toLowerCase();
			if (action === "on" || action === "enable") enabled = true;
			else if (action === "off" || action === "disable") enabled = false;
			else if (action === "toggle" || action === "") enabled = !enabled;
			else if (action !== "status") {
				ctx.ui.notify("Usage: /windows-input on|off|toggle|status", "warning");
				return;
			}
			apply(ctx);
			ctx.ui.notify(`Windows input: ${enabled ? "on" : "off"}`, "info");
		},
	});
}
