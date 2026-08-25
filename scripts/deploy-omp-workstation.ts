import { copyFile, lstat, open, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MIN_BINARY_BYTES = 1024 * 1024;

export interface OmpDeploymentResult {
	target: string;
	retiredCollision: boolean;
	pendingCleanup: string[];
}

async function validateCompiledExecutable(path: string): Promise<number> {
	const status = await lstat(path).catch(() => undefined);
	if (!status?.isFile() || status.size < MIN_BINARY_BYTES) {
		throw new Error(`OMP artifact must be a compiled executable of at least ${MIN_BINARY_BYTES} bytes: ${path}`);
	}
	const handle = await open(path, "r");
	try {
		const signature = Buffer.allocUnsafe(2);
		await handle.read(signature, 0, signature.length, 0);
		if (signature[0] !== 0x4d || signature[1] !== 0x5a) {
			throw new Error(`OMP artifact is not a Windows PE executable: ${path}`);
		}
	} finally {
		await handle.close();
	}
	return status.size;
}

async function removeWhenUnlocked(path: string, pendingCleanup: string[]): Promise<void> {
	try {
		await rm(path, { force: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw error;
		if (!pendingCleanup.includes(path)) pendingCleanup.push(path);
	}
}

async function cleanupRotatedArtifacts(binDir: string, pendingCleanup: string[]): Promise<void> {
	const names = await readdir(binDir);
	for (const name of names) {
		if (
			!name.startsWith("omp.exe.previous") &&
			!name.startsWith("omp.com.retired") &&
			!name.startsWith("pi_natives.win32-x64-baseline.node.")
		) {
			continue;
		}
		await removeWhenUnlocked(join(binDir, name), pendingCleanup);
	}
}

export async function deployOmpWorkstation(source: string, binDir = join(homedir(), ".bun", "bin")): Promise<OmpDeploymentResult> {
	if (process.platform !== "win32") throw new Error("OMP workstation deployment is Windows-only");
	const sourcePath = resolve(source);
	const target = join(binDir, "omp.exe");
	const collision = join(binDir, "omp.com");
	const rotationId = `${Date.now()}-${process.pid}`;
	const retiredCollision = join(binDir, `omp.com.retired-${rotationId}`);
	const previous = join(binDir, `omp.exe.previous-${rotationId}`);
	const next = join(binDir, "omp.exe.next");
	const expectedSize = await validateCompiledExecutable(sourcePath);
	const pendingCleanup: string[] = [];
	await cleanupRotatedArtifacts(binDir, pendingCleanup);
	let collisionRetired = false;
	if ((await lstat(collision).catch(() => undefined))?.isFile()) {
		await rename(collision, retiredCollision);
		collisionRetired = true;
	}

	if (resolve(target) !== sourcePath) {
		await rm(next, { force: true });
		await copyFile(sourcePath, next);
		const copiedSize = await validateCompiledExecutable(next);
		if (copiedSize !== expectedSize) throw new Error(`Staged OMP artifact size mismatch: ${copiedSize} != ${expectedSize}`);

		const targetExists = (await lstat(target).catch(() => undefined))?.isFile() ?? false;
		if (targetExists) await rename(target, previous);
		try {
			await rename(next, target);
		} catch (error) {
			if (targetExists) await rename(previous, target);
			throw error;
		}
	}

	await validateCompiledExecutable(target);
	if ((await lstat(collision).catch(() => undefined))?.isFile()) {
		throw new Error(`Launcher collision remains after deployment: ${collision}`);
	}
	await removeWhenUnlocked(retiredCollision, pendingCleanup);
	await removeWhenUnlocked(previous, pendingCleanup);
	return { target, retiredCollision: collisionRetired, pendingCleanup };
}

if (import.meta.main) {
	const source = process.argv[2] ?? join(homedir(), ".bun", "bin", "omp-transcript-filters.exe");
	const result = await deployOmpWorkstation(source);
	console.log(`OMP deployed: ${result.target}`);
	if (result.retiredCollision) console.log("Retired conflicting omp.com launcher");
	for (const path of result.pendingCleanup) console.log(`Cleanup pending until the active process exits: ${path}`);
}
