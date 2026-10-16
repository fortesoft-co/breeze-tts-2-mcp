import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Drive the BUILT server binary over stdio, like a real MCP host would.
const transport = new StdioClientTransport({
	command: "node",
	args: [new URL("../dist/src/server.js", import.meta.url).pathname],
	env: {
		BREEZE_TTS_URL: "http://127.0.0.1:1923",
		BREEZE_TTS_PLAYER: "/bin/true",
	},
});
const client = new Client({ name: "prod-smoke", version: "1.0.0" });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log("BUILT_SERVER_TOOLS:", tools.join(", "));

const result = await client.callTool({
	name: "speak",
	arguments: { text: "The production build speaks.", instruction: "Crisp." },
});
console.log(
	"RESULT:",
	(result.content as Array<{ type: string; text?: string }>)
		.map((c) => c.text ?? "")
		.join(" ")
		.slice(0, 120),
);

await client.close();
console.log("PROD_SMOKE_OK");
