import { open, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MANAGED_MARKER = "// @orca-managed-pi-extension";

const VULNERABLE_AGENT_END = `  pi.on('agent_end', async (event, ctx) => {
    if (event?.willContinue === true) {
      clearPendingAgentEndCheck()
      return
    }
    if (!ctx || typeof ctx.isIdle !== 'function') {
      stopAnimation(ctx)
      return
    }
    clearPendingAgentEndCheck()
    agentEndIdleRecheckMs = AGENT_END_IDLE_RECHECK_MS
    pendingAgentEndContext = ctx
    pendingAgentEndCheck = setTimeout(checkPendingAgentEnd, 0)
    if (typeof pendingAgentEndCheck.unref === 'function') pendingAgentEndCheck.unref()
  })`;

const SETTLED_AGENT_END = `  pi.on('agent_end', async (event, ctx) => {
    if (event?.willContinue === true) {
      clearPendingAgentEndCheck()
      return
    }
    stopAnimation(ctx)
  })`;

const ARCHIVE_CONTEXT_PREFIX =
	"`    if (event?.willContinue === true) {`,`      clearPendingAgentEndCheck()`,`      return`,`    }`,";
const ARCHIVE_VULNERABLE_LINE = "`    if (!ctx || typeof ctx.isIdle !== 'function') {`";
const ARCHIVE_SETTLED_LINE = `\`    if (true) {\`${
	" ".repeat(ARCHIVE_VULNERABLE_LINE.length - "`    if (true) {`".length)
}`;
const ARCHIVE_VULNERABLE_CONTEXT = Buffer.from(ARCHIVE_CONTEXT_PREFIX + ARCHIVE_VULNERABLE_LINE);
const ARCHIVE_SETTLED_CONTEXT = Buffer.from(ARCHIVE_CONTEXT_PREFIX + ARCHIVE_SETTLED_LINE);

export function settleOmpTitlebarSpinnerSource(source: string): { source: string; changed: boolean } {
	if (!source.includes(MANAGED_MARKER)) {
		throw new Error("refusing to patch an extension not managed by Orca");
	}
	if (source.includes(SETTLED_AGENT_END)) return { source, changed: false };
	if (!source.includes(VULNERABLE_AGENT_END)) {
		throw new Error("Orca titlebar spinner source does not match the supported 1.4.197 lifecycle");
	}
	return { source: source.replace(VULNERABLE_AGENT_END, SETTLED_AGENT_END), changed: true };
}

export function defaultOrcaTitlebarSpinnerPath(): string {
	return join(homedir(), ".omp", "agent", "extensions", "orca-titlebar-spinner.ts");
}

export function defaultOrcaArchivePath(): string {
	const localAppData = process.env.LOCALAPPDATA;
	if (!localAppData) throw new Error("LOCALAPPDATA is required to locate Orca");
	return join(localAppData, "Programs", "orca", "resources", "app.asar");
}

export function locateOrcaSpinnerArchivePatch(archive: Uint8Array): { offset: number; changed: boolean } {
	const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
	const vulnerableOffset = bytes.indexOf(ARCHIVE_VULNERABLE_CONTEXT);
	if (vulnerableOffset >= 0) {
		if (bytes.indexOf(ARCHIVE_VULNERABLE_CONTEXT, vulnerableOffset + 1) >= 0) {
			throw new Error("Orca archive contains multiple titlebar spinner patch seams");
		}
		return {
			offset: vulnerableOffset + ARCHIVE_CONTEXT_PREFIX.length,
			changed: true,
		};
	}
	const settledOffset = bytes.indexOf(ARCHIVE_SETTLED_CONTEXT);
	if (settledOffset >= 0) return { offset: settledOffset + ARCHIVE_CONTEXT_PREFIX.length, changed: false };
	throw new Error("Orca archive does not match the supported 1.4.197 titlebar spinner generator");
}

export async function patchOrcaSpinnerArchive(path = defaultOrcaArchivePath()): Promise<boolean> {
	const archive = await readFile(path);
	const patch = locateOrcaSpinnerArchivePatch(archive);
	if (!patch.changed) return false;
	const file = await open(path, "r+");
	try {
		await file.write(ARCHIVE_SETTLED_LINE, patch.offset, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	return true;
}

export async function patchOrcaOmpSpinner(
	extensionPath = defaultOrcaTitlebarSpinnerPath(),
	archivePath = defaultOrcaArchivePath(),
): Promise<{ archiveChanged: boolean; extensionChanged: boolean }> {
	const archiveChanged = await patchOrcaSpinnerArchive(archivePath);
	const current = await readFile(extensionPath, "utf8");
	const result = settleOmpTitlebarSpinnerSource(current);
	if (result.changed) await writeFile(extensionPath, result.source, "utf8");
	return { archiveChanged, extensionChanged: result.changed };
}

if (import.meta.main) {
	const result = await patchOrcaOmpSpinner();
	const archiveState = result.archiveChanged ? "patched" : "already patched";
	const extensionState = result.extensionChanged ? "patched" : "already patched";
	console.log(`Orca OMP spinner generator ${archiveState}; active extension ${extensionState}.`);
}
