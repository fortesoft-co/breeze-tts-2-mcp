// Phase 2/3: {voice} carry-mode parsing + speakScript integration.
// Run: BREEZE_TTS_PLAYER=/bin/true npx tsx test/speakscript.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseDirectives } from "../src/directives.ts";

let failures = 0;
function check(name: string, run: () => void): void {
	try {
		run();
		console.log(`  ok  ${name}`);
	} catch (error) {
		failures += 1;
		console.error(`FAIL  ${name}: ${error}`);
	}
}
function expect(condition: unknown, message: string): void {
	if (!condition) throw new Error(message);
}

check("carry mode: voice changes ride onto segments, count reported", () => {
	const { segments, report } = parseDirectives(
		"Hello. {voice:jessica} Hey there. {voice:default} So long.",
		{ voiceMode: "carry" },
	);
	expect(segments.length === 3, JSON.stringify(segments));
	expect(segments[0].voiceId === undefined, "narrator piece must carry no voice");
	expect(segments[1].voiceId === "jessica", `got ${segments[1].voiceId}`);
	expect(segments[2].voiceId === "default", `got ${segments[2].voiceId}`);
	expect(report.voiceChanges === 2, `got ${report.voiceChanges}`);
	expect(report.ignoredWiring.length === 0, "carry mode must not list ignored");
});

check("sticky across a pause boundary", () => {
	const { segments } = parseDirectives("A {voice:jessica} B {pause:1} C", {
		voiceMode: "carry",
	});
	expect(segments.length === 3, JSON.stringify(segments));
	expect(segments[1].voiceId === "jessica" && segments[2].voiceId === "jessica",
		`sticky failed: ${JSON.stringify(segments)}`);
	expect(segments[2].pauseBeforeMs === 1000, `pause lost: ${JSON.stringify(segments)}`);
});

check("speak mode: voice ignored, split kept (uniform boundary rule)", () => {
	const { segments, report } = parseDirectives("Hi. {voice:somebody} bye", {});
	expect(segments.length === 2, JSON.stringify(segments));
	expect(
		segments.every((s) => s.voiceId === undefined),
		`voice leaked into segments: ${JSON.stringify(segments)}`,
	);
	expect(report.ignoredWiring.length === 1 && report.ignoredWiring[0].includes("somebody"),
		JSON.stringify(report.ignoredWiring));
});

// --- integration through the deployed-path server (local tsx spawn) ---

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
const client = new Client({ name: "speakscript-test", version: "0" });
await client.connect(transport);

function text(result: unknown): string {
	const content = (result as { content?: Array<{ type: string; text?: string }> })
		.content;
	return (content ?? [])
		.map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : JSON.stringify(c)))
		.join("\n");
}

// 1. full cast flow: narrator + designed member + pause
const performed = await client.callTool({
	name: "speakScript",
	arguments: {
		script:
			"Narrator opens the scene. {voice:stage-test} And the guest answers sharply. {pause:0.5} Narrator closes it.",
		cast: { "stage-test": "A brisk radio announcer, male" },
	},
});
const performedText = text(performed);
console.log(performedText);
expect(performedText.includes("designed"), "expected on-the-fly cast design");
expect(/Performed \d/.test(performedText), "expected a performed report");
expect(performedText.includes("Cast:"), "expected a cast line");

// 2. fail-fast: unknown voice, no cast description
const missing = await client.callTool({
	name: "speakScript",
	arguments: { script: "Hello. {voice:no-such-cast} nope" },
});
const missingText = text(missing);
console.log(missingText);
expect(
	missingText.includes("no-such-cast") && missingText.includes("Error"),
	`expected a fail-fast error naming the voice: ${missingText}`,
);

// 3. speak redirects {voice} to speakScript
const redirect = await client.callTool({
	name: "speak",
	arguments: { text: "Hi. {voice:somebody} bye" },
});
const redirectText = text(redirect);
console.log(redirectText);
expect(
	redirectText.includes("speakScript"),
	`speak must redirect {voice} to speakScript: ${redirectText}`,
);

await client.close();
if (failures > 0) {
	console.error(`\n${failures} speakScript test(s) FAILED`);
	process.exitCode = 1;
} else {
	console.log("\nSPEAKSCRIPT_OK");
}