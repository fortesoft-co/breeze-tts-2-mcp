// Interface semantics: a blocking speak resolves at GENERATION end (playback
// queues right after — MCP clients time tool requests out, so waiting for the
// full playback would race the timeout), and clips estimated past the
// blocking audio budget degrade to background jobs automatically.
// Run: BREEZE_TTS_PLAYER=/bin/true npx tsx test/speak-semantics.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
	command: "npx",
	args: ["tsx", "src/server.ts"],
	cwd: new URL("..", import.meta.url).pathname,
	env: {
		...process.env,
		BREEZE_TTS_PLAYER: "/bin/true",
		BREEZE_TTS_WORK_DIR: "./breeze-tts-work",
	} as Record<string, string>,
});
const client = new Client({ name: "semantics-test", version: "0" });
await client.connect(transport);

function text(result: unknown): string {
	const content = (result as { content?: Array<{ type: string; text?: string }> })
		.content;
	return (content ?? [])
		.map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
		.join("\n");
}

// 1. blocking short call: fast return, honest queue wording
const shortStarted = Date.now();
const short = await client.callTool({
	name: "speak",
	arguments: { text: "Blocking probe, just a few seconds long." },
});
const shortTook = Date.now() - shortStarted;
console.log(`short blocking call: ${shortTook}ms`);
if (shortTook > 15_000)
	throw new Error(
		`blocking call held ${shortTook}ms — resolve must fire at generation end, not playback end`,
	);
const shortText = text(short);
if (!/Queued for playback through the local speakers/.test(shortText))
	throw new Error(`playback wording not honest: ${shortText}`);

// 2. long clip: must degrade to a background submission instead of holding
const long = await client.callTool({
	name: "speak",
	arguments: {
		text:
			"This is the auto-background guard test line. ".repeat(30) +
			"The guard should have degraded this whole narration to a background job instead of holding the agent for its duration.",
	},
});
const longText = text(long);
console.log(longText);
if (!/background job \[/.test(longText))
	throw new Error(`long clip was not auto-submitted as background: ${longText}`);

// 3. the job bookkeeping shows the background job exists
const jobs = await client.callTool({ name: "speechJobs", arguments: {} });
console.log(text(jobs));

await client.close();
console.log("SEMANTICS_OK");