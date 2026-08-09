import { OmpRpcClient } from "../src/omp-rpc-client.ts";

const message = process.argv.slice(2).join(" ").trim();
if (!message) {
	console.error('usage: bun examples/rpc-once.ts "your prompt"');
	process.exit(2);
}

const client = new OmpRpcClient({
	cwd: process.cwd(),
	onStderr: text => process.stderr.write(text),
});

try {
	const ready = await client.start();
	console.error(`OMP RPC ready; supported=${ready.supportedProtocolVersions?.join(",") ?? ready.protocolVersion}`);
	const prompt = await client.prompt(message);
	const last = await client.request({ type: "get_last_assistant_text" }, "last-text");
	const text = typeof last.data?.text === "string" ? last.data.text : "";
	if (text) process.stdout.write(`${text}\n`);
	console.error(`prompt ${prompt.id} settled via ${String(prompt.completion.type)}`);
} finally {
	await client.close();
}
