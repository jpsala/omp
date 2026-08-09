import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

interface TopicMetadata {
	path: string;
	title: string;
	status: string;
	summary: string;
}

const workspace = dirname(dirname(fileURLToPath(import.meta.url)));
const topicsDirectory = join(workspace, "topics");
const outputPath = join(workspace, "docs", "TOPICS.md");

async function collectTopics(): Promise<TopicMetadata[]> {
	const entries = await readdir(topicsDirectory, { withFileTypes: true });
	const markdownFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith(".md"));
	const topics = await Promise.all(
		markdownFiles.map(async entry => {
			const path = join(topicsDirectory, entry.name);
			const content = await readFile(path, "utf8");
			const title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
			const status = /^Status:\s*(.+)$/m.exec(content)?.[1]?.trim();
			const summary = /^Summary:\s*(.+)$/m.exec(content)?.[1]?.trim();
			if (!title || !status || !summary) {
				throw new Error(`${relative(workspace, path)} requires # title, Status: and Summary:`);
			}
			return {
				path: relative(workspace, path).replaceAll("\\", "/"),
				title,
				status,
				summary,
			};
		}),
	);
	return topics.sort((left, right) => left.title.localeCompare(right.title, "en"));
}

function renderIndex(topics: TopicMetadata[]): string {
	const rows = topics.map(topic => `| [${topic.title}](../${topic.path}) | ${topic.status} | ${topic.summary} |`);
	return [
		"# Topics",
		"",
		"Índice generado por `bun run index`. Editar los archivos de `topics/`, no esta tabla.",
		"",
		"| Topic | Status | Summary |",
		"| --- | --- | --- |",
		...rows,
		"",
	].join("\n");
}

const expected = renderIndex(await collectTopics());
if (process.argv.includes("--check")) {
	const actual = await readFile(outputPath, "utf8").catch(() => "");
	if (actual !== expected) {
		console.error("docs/TOPICS.md is stale; run bun run index");
		process.exitCode = 1;
	}
} else {
	await writeFile(outputPath, expected, "utf8");
	console.log(`updated ${relative(workspace, outputPath)}`);
}
