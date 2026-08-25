import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployOmpWorkstation } from "../scripts/deploy-omp-workstation.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fakeExecutable(path: string, marker: number): Promise<void> {
	const bytes = Buffer.alloc(1024 * 1024, marker);
	bytes[0] = 0x4d;
	bytes[1] = 0x5a;
	await writeFile(path, bytes);
}

test("deploys only omp.exe and retires a conflicting omp.com", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-deploy-"));
	roots.push(root);
	const source = join(root, "source.exe");
	const binDir = join(root, "bin");
	await mkdir(binDir);
	await fakeExecutable(source, 0x31);
	await fakeExecutable(join(binDir, "omp.exe"), 0x32);
	await fakeExecutable(join(binDir, "omp.com"), 0x33);

	const result = await deployOmpWorkstation(source, binDir);
	expect(result.retiredCollision).toBe(true);
	expect(result.pendingCleanup).toEqual([]);
	expect((await readFile(join(binDir, "omp.exe"))).equals(await readFile(source))).toBe(true);
	expect(await lstat(join(binDir, "omp.com")).catch(() => undefined)).toBeUndefined();
	expect(await lstat(join(binDir, "omp.com.retired")).catch(() => undefined)).toBeUndefined();
});

test("rejects a non-PE artifact without disturbing the active launcher", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-deploy-invalid-"));
	roots.push(root);
	const source = join(root, "source.exe");
	const binDir = join(root, "bin");
	await mkdir(binDir);
	await writeFile(source, Buffer.alloc(1024 * 1024, 0x31));
	await fakeExecutable(join(binDir, "omp.exe"), 0x32);

	await expect(deployOmpWorkstation(source, binDir)).rejects.toThrow("not a Windows PE executable");
	const active = await readFile(join(binDir, "omp.exe"));
	expect(active[2]).toBe(0x32);
});
