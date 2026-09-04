import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	patchOrcaSpinnerArchive,
	settleOmpTitlebarSpinnerSource,
} from "../scripts/patch-orca-omp-spinner.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const vulnerableExtension = `// @orca-managed-pi-extension
export default function (pi) {
  function clearPendingAgentEndCheck() {}
  function stopAnimation(ctx) { ctx.stops++ }
  const AGENT_END_IDLE_RECHECK_MS = 25
  let agentEndIdleRecheckMs = AGENT_END_IDLE_RECHECK_MS
  let pendingAgentEndContext = null
  let pendingAgentEndCheck = null
  function checkPendingAgentEnd() {}
  pi.on('agent_end', async (event, ctx) => {
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
  })
}`;

test("terminal OMP agent_end stops the Orca title spinner without waiting for isIdle", async () => {
	const patched = settleOmpTitlebarSpinnerSource(vulnerableExtension);
	const hooks = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
	const load = new Function(patched.source.replace("export default function (pi)", "return function (pi)"));
	const extension = load() as (pi: { on(name: string, handler: (event: unknown, context: unknown) => Promise<void>): void }) => void;
	extension({ on: (name, handler) => hooks.set(name, handler) });
	const agentEnd = hooks.get("agent_end");
	expect(agentEnd).toBeDefined();

	const context = { stops: 0, isIdle: () => false };
	await agentEnd?.({ willContinue: true }, context);
	expect(context.stops).toBe(0);
	await agentEnd?.({ willContinue: false }, context);
	expect(context.stops).toBe(1);
	await agentEnd?.({}, context);
	expect(context.stops).toBe(2);
});

test("patch is idempotent and rejects unknown generated source", () => {
	const first = settleOmpTitlebarSpinnerSource(vulnerableExtension);
	expect(first.changed).toBe(true);
	expect(settleOmpTitlebarSpinnerSource(first.source)).toEqual({ source: first.source, changed: false });
	expect(() => settleOmpTitlebarSpinnerSource("// @orca-managed-pi-extension\nexport default () => {}"))
		.toThrow("does not match the supported 1.4.197 lifecycle");
});

test("patches the unique bundled spinner generator seam without changing archive size", async () => {
	const root = await mkdtemp(join(tmpdir(), "orca-spinner-"));
	roots.push(root);
	const archivePath = join(root, "app.asar");
	const vulnerableContext =
		"`    if (event?.willContinue === true) {`,`      clearPendingAgentEndCheck()`,`      return`,`    }`,`    if (!ctx || typeof ctx.isIdle !== 'function') {`";
	await writeFile(archivePath, Buffer.from(`prefix${vulnerableContext},suffix`));
	const before = await readFile(archivePath);

	expect(await patchOrcaSpinnerArchive(archivePath)).toBe(true);
	const after = await readFile(archivePath);
	expect(after.length).toBe(before.length);
	expect(after.toString()).toContain("`    if (true) {`");
	expect(await patchOrcaSpinnerArchive(archivePath)).toBe(false);
});
