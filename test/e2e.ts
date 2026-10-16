// End-to-end: spawn the server over stdio, drive it as a real MCP client.
// Run with a silent player to avoid sound: BREEZE_TTS_PLAYER=/bin/true npm run test:e2e

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main(): Promise<void> {
	const transport = new StdioClientTransport({
		command: "npx",
		args: ["tsx", "src/server.ts"],
		cwd: new URL("..", import.meta.url).pathname,
	});
	const client = new Client({ name: "e2e-test", version: "1.0.0" });
	await client.connect(transport);

	const toolNames = (await client.listTools()).tools.map((t) => t.name).sort();
	console.log("TOOLS:", toolNames.join(", "));

	async function call(
		name: string,
		args: Record<string, unknown>,
	): Promise<void> {
		const result = await client.callTool({ name, arguments: args });
		const text = (result.content as Array<{ type: string; text?: string }>)
			.map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
			.join("\n");
		console.log(`\n== ${name} ==\n${text}`);
	}

	await call("listVoices", {});
	await call("speak", {
		text: "Hello from the MCP server. This clip travelled over the protocol.",
		instruction: "Neutral and clear.",
	});

	// background submission: returns immediately, then completes on its own
	await call("speak", {
		text: "This one runs in the background while you carry on.",
		instruction: "Casual aside.",
		background: true,
	});
	await call("speechJobs", {});
	await call("designVoice", {
		description: "A friendly bedtime storyteller, unhurried.",
		name: "mcp-storyteller",
	});
	await call("listVoices", {});
	await call("speak", {
		text: "Now speaking through the MCP-designed voice.",
		voiceId: "mcp-storyteller",
		instruction: "Soft and warm.",
	});
	await call("deleteVoice", { voiceId: "mcp-storyteller" });

	// wait for the background job to reach a terminal state
	for (let index = 0; index < 30; index++) {
		const jobs = await client.callTool({ name: "speechJobs", arguments: {} });
		const text = (jobs.content as Array<{ type: string; text?: string }>)
			.map((c) => (c.type === "text" ? c.text : ""))
			.join(" ");
		if (/\[(\w+)\] (done|error)/.test(text)) {
			console.log(`\n== speechJobs final ==\n${text}`);
			break;
		}
		await new Promise((r) => setTimeout(r, 1000));
	}

	await client.close();
	console.log("\nE2E_OK");
}

main().catch((error) => {
	console.error("E2E FAILED:", error);
	process.exitCode = 1;
});
