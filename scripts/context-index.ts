import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

type DirectoryEntry = {
  isDirectory(): boolean;
  isFile(): boolean;
  name: string;
};

const root = resolve(".");

function exists(path: string): boolean {
  return existsSync(join(root, path));
}

function existsRegistryPath(cell: string): boolean {
  const paths = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  if (!paths.length) paths.push(cell.trim());
  return paths.some((path) =>
    existsSync(isAbsolute(path) ? path : join(root, path)),
  );
}

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function configuredActiveSpecPath(): string | undefined {
  if (!exists(".specify/feature.json")) return undefined;
  try {
    const config = JSON.parse(read(".specify/feature.json")) as {
      feature_directory?: unknown;
    };
    return typeof config.feature_directory === "string" && config.feature_directory.trim()
      ? resolve(root, config.feature_directory)
      : undefined;
  } catch {
    return undefined;
  }
}

function frontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match?.[1] ?? "";
}

function scalar(frontmatterText: string, key: string): string {
  const match = frontmatterText.match(new RegExp(`^${key}:[ \\t]*([^\\r\\n]*)`, "m"));
  return match?.[1]?.trim() ?? "";
}

function list(frontmatterText: string, key: string): string[] {
  const match = frontmatterText.match(new RegExp(`^${key}:\\s*\\r?\\n((?:\\s+- .+\\r?\\n?)+)`, "m"));
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^- /, "").trim())
    .filter(Boolean);
}

function markdownFiles(dir: string): string[] {
  const fullDir = join(root, dir);
  if (!existsSync(fullDir)) return [];
  return readdirSync(fullDir, { withFileTypes: true })
    .filter(
      (entry: DirectoryEntry) =>
        entry.isFile() && entry.name.endsWith(".md"),
    )
    .map((entry: DirectoryEntry) =>
      `${dir}/${entry.name}`.replaceAll("\\", "/"),
    )
    .sort();
}

function title(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? "Untitled";
}

function trackStatus(content: string): string {
  const fm = frontmatter(content);
  return scalar(fm, "status") || "unknown";
}

function focusedTrackPaths(): Set<string> {
  if (!exists("docs/WORKING_MEMORY.md")) return new Set();
  const memory = read("docs/WORKING_MEMORY.md");
  const heading = "## Foco Único De Ejecución";
  const start = memory.indexOf(heading);
  if (start < 0) return new Set();
  const remainder = memory.slice(start + heading.length);
  const nextHeading = remainder.search(/\r?\n##\s/);
  const focus = nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder;
  const state = focus.match(/^- \*\*Estado:\*\* `([^`]+)`/m)?.[1];
  const field = state === "ready" ? "Plan" : state === "blocked" || state === "waiting_gate" ? "Referencia" : undefined;
  if (!field) return new Set();
  const pattern = new RegExp("^- \\*\\*" + field + ":\\*\\* `(docs/tracks/[^`]+\\.md)`", "gm");
  return new Set([...focus.matchAll(pattern)].map((match) => match[1]));
}

const lines: string[] = [];
lines.push("# Context Index");
lines.push("");
lines.push("Generated cache. Do not edit by hand.");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");

lines.push("## Topics");
lines.push("");
for (const path of markdownFiles("docs/topics")) {
  const content = read(path);
  const fm = frontmatter(content);
  const status = scalar(fm, "status") || "unknown";
  const triggers = list(fm, "triggers").slice(0, 8).join(", ");
  const label = path.replace("docs/topics/", "").replace(/\.md$/, "");
  lines.push(`- ${status}: [${label}](../${path.replace("docs/", "")})${triggers ? ` - ${triggers}` : ""}`);
}
lines.push("");

lines.push("## Tracks");
lines.push("");
const focusedTracks = focusedTrackPaths();
let focusedTrackCount = 0;
for (const path of markdownFiles("docs/tracks")) {
  if (path.endsWith("/README.md") || path.endsWith("/TEMPLATE.md") || !focusedTracks.has(path)) continue;
  const content = read(path);
  const status = trackStatus(content);
  const label = title(content);
  lines.push(`- ${status}: [${label}](../${path.replace("docs/", "")})`);
  focusedTrackCount += 1;
}
if (!focusedTrackCount) lines.push("- No focused track. Search `docs/tracks/` on demand.");
else lines.push("- Other tracks are omitted from the hot index; search `docs/tracks/` on demand.");
lines.push("");

lines.push("## Specs");
lines.push("");
const specRoots = ["specs", ".specify/specs"].filter(exists);
const specs = specRoots
  .flatMap((specRoot) =>
    readdirSync(join(root, specRoot), { withFileTypes: true })
      .filter((entry: DirectoryEntry) => entry.isDirectory())
      .map((entry: DirectoryEntry) => ({ root: specRoot, name: entry.name })),
  )
  .sort((left, right) => `${left.root}/${left.name}`.localeCompare(`${right.root}/${right.name}`));
const activeSpecPath = configuredActiveSpecPath();
const activeSpecs = specs.filter(
  (spec) => resolve(root, spec.root, spec.name) === activeSpecPath,
);
if (activeSpecs.length) {
  for (const spec of activeSpecs) {
    lines.push(`- active: [${spec.name}](../../${spec.root}/${spec.name}/)`);
  }
} else {
  lines.push("- No active spec directories found.");
}
for (const spec of specs.filter((spec) => !activeSpecs.includes(spec))) {
  lines.push(`- historical: [${spec.name}](../../${spec.root}/${spec.name}/)`);
}
lines.push("");

lines.push("## OS Projects");
lines.push("");
if (exists("docs/OS_PROJECTS.md")) {
  const registry = read("docs/OS_PROJECTS.md");
  const projectRows: string[] = [];
  let headers: string[] = [];
  for (const line of registry.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const normalized = cells.map((cell) =>
      cell.replace(/^`|`$/g, "").trim().toLowerCase(),
    );
    if (normalized.includes("id") && normalized.includes("path")) {
      headers = normalized;
      continue;
    }

    const idIndex = headers.indexOf("id");
    const pathIndex = headers.indexOf("path");
    const statusIndex = Math.max(
      headers.indexOf("estado"),
      headers.indexOf("status"),
    );
    const readinessIndex = headers.indexOf("readiness omp");
    if (idIndex < 0 || pathIndex < 0 || !cells[pathIndex]) continue;
    if (!/`(?:\.\.\/|[A-Za-z]:)/.test(cells[pathIndex])) continue;

    const localAvailability = existsRegistryPath(cells[pathIndex])
      ? ""
      : " - unavailable locally";
    const readiness =
      readinessIndex >= 0 && cells[readinessIndex]
        ? `; readiness: ${cells[readinessIndex]}`
        : "";
    const status = statusIndex >= 0 ? cells[statusIndex] : "registered";
    projectRows.push(
      `- ${status}: ${cells[idIndex]} (${cells[pathIndex]})${readiness}${localAvailability}`,
    );
  }
  lines.push("- Registry: [docs/OS_PROJECTS.md](../OS_PROJECTS.md)");
  if (projectRows.length) lines.push(...projectRows);
} else {
  lines.push("- No OS project registry found.");
}
lines.push("");

lines.push("## Skills");
lines.push("");
const skillDirs: string[] = exists("docs/skills")
  ? readdirSync(join(root, "docs", "skills"), { withFileTypes: true })
    .filter((entry: DirectoryEntry) => entry.isDirectory())
    .map((entry: DirectoryEntry) => entry.name)
    .sort()
  : [];
if (skillDirs.length) {
  lines.push("- Canon: [docs/skills/](../skills/)");
  lines.push("- Manager discovery: off by default in `os`; use `bun run skills:on` only for explicit manager operations.");
  if (skillDirs.includes("foundry-projects")) {
    lines.push("- Foundry provider: individual user projection via `bun run foundry:skills -- status`; it never enables the manager catalog.");
  }
  lines.push("- Guidance: [local-agent-skills](../topics/local-agent-skills.md)");
} else {
  lines.push("- Missing docs/skills/");
}
lines.push("");


lines.push("## AOS Glossary");
lines.push("");
if (exists("docs/GLOSSARY.md")) {
  const glossary = read("docs/GLOSSARY.md");
  const terms = glossary
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|") && !line.includes("---") && !line.includes("Termino"))
    .map((line) => line.split("|").map((cell) => cell.trim()).filter(Boolean)[0])
    .filter(Boolean)
    .slice(0, 18);
  lines.push("- Full glossary: [docs/GLOSSARY.md](../GLOSSARY.md)");
  if (terms.length) lines.push(`- Common terms: ${terms.join(", ")}`);
} else {
  lines.push("- No glossary found.");
}
lines.push("");

while (lines.at(-1) === "") lines.pop();

const output = "docs/.generated/context-index.md";
mkdirSync(dirname(join(root, output)), { recursive: true });
writeFileSync(join(root, output), `${lines.join("\n")}\n`);
console.log(`Wrote ${output}`);
