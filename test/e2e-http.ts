import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";

const PORT = Number(process.env.BREEZE_TTS_MCP_HTTP_PORT ?? 38123);
const child = spawn(
	"npx",
	["tsx", "src/server.ts", "--http", String(PORT)],
	{
		cwd: new URL("..", import.meta.url).pathname,
		env: {
			...process.env,
			BREEZE_TTS_PLAYER: "/bin/true",
			BREEZE_TTS_WORK_DIR: "./breeze-tts-work-http",
		},
		stdio: ["ignore", "inherit", "inherit"],
	},
);

const deadline = Date.now() + 30_000;
let healthy = false;
while (Date.now() < deadline && !healthy) {
	try {
		const res = await fetch(`http://127.0.0.1:${PORT}/health`);
		if (res.ok) healthy = true;
	} catch {
		await new Promise((r) => setTimeout(r, 200));
	}
}
if (!healthy) throw new Error("http server never became healthy");

try {
	const client = new Client({ name: "e2e-http", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)),
	);

	const tools = (await client.listTools()).tools.map((t) => t.name).sort();
	console.log("HTTP_TOOLS:", tools.join(", "));

	const result = await client.callTool({
		name: "speak",
		arguments: {
			text: "Speaking over streamable http.",
			instruction: "Clear.",
		},
	});
	console.log(
		"HTTP_RESULT:",
		(result.content as Array<{ type: string; text?: string }>)
			.map((c) => c.text ?? "")
			.join(" ")
			.slice(0, 100),
	);

	await client.close();
	console.log("HTTP_E2E_OK");
} finally {
	child.kill("SIGTERM");
}