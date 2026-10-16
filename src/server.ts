#!/usr/bin/env node
/**
 * breeze-tts-mcp — MCP server (stdio) exposing the Breeze-TTS-2.cpp voice
 * toolset to any MCP client: speak aloud with voice direction, design new
 * voices from descriptions, and manage the saved voice library.
 *
 * Every log goes to stderr: stdout carries the MCP protocol.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";
import { z } from "zod";
import {
	BREEZE_TTS_VOICE,
	deleteVoiceEntry,
	generateSpeech,
	listVoiceEntries,
	pcmToWav,
	registerVoice,
	VOICE_NAME_RE,
	type VoiceEntry,
} from "./breezeClient.ts";
import {
	describeSpeechJobs,
	playWavFile,
	speakText,
	submitSpeech,
} from "./speech.ts";
import { cleanForSpeech } from "./textClean.ts";

function log(...parts: unknown[]): void {
	console.error("[breeze-tts-mcp]", ...parts);
}

/// --- MCP server ---

const server = new McpServer({
	name: "breeze-tts-mcp",
	version: "1.0.0",
});

// Blocking speak holds the agent until generation ends, and MCP clients time
// tool requests out (~30-60s) — so clips longer than this audio budget are
// auto-submitted as background jobs instead, on any hardware.
const BLOCKING_AUDIO_BUDGET_S = 45;
const EST_CHARS_PER_SECOND = 10.5; // conservative: the engine measures ~10-18 chars/s

server.registerTool(
	"speak",
	{
		title: "Speak aloud",
		description:
			"Speak text out loud through the local speakers using the Breeze-TTS-2.cpp server, with voice direction. " +
			'Says the text in the saved voice "default" by default while following a delivery instruction. ' +
			"Long text is split on sentence boundaries into pieces, each generated separately and separated by a beat of silence. " +
			"Markdown, URLs, emoji and code blocks are stripped automatically before speaking; code blocks are skipped entirely rather than read aloud. " +
			"Free-form vocal-event paralinguistic tags can be embedded in the text - e.g. (sigh), (laugh), (whispering), (clears throat), [叹气] - place them at the natural spot when the line calls for an audible emotional beat; they fire best with cfgScale 2-3, which is the default. " +
			"Delivery shifts work inline the same way: (whispering), (angry), (return to normal) style tags re-steer the voice from the tag onward within the same generation. " +
			"Pause directives are supported: {pause:2.5} inserts exactly 2.5 seconds of silence (seconds, decimal; clamped 0-15) and every directive also ends the current piece — place them between sentences for clean takes. " +
			"Blocking calls hold the agent only until GENERATION ends; playback queues and continues right after. Clips longer than the blocking audio budget (~45s of speech) are submitted as background jobs instead — speechJobs polls them.",
		inputSchema: {
			text: z
				.string()
				.min(1)
				.describe(
					"The text to speak. Embed free-form vocal-event tags like (sigh), (laugh), (whispering) or (clears throat) at the spots where the delivery should show emotion.",
				),
			instruction: z
				.string()
				.optional()
				.describe(
					"Voice direction: how to deliver the line, e.g. 'Speak slowly with a restrained, serious tone.' or 'Warm and cheerful, like a friendly guide.'",
				),
			cfgScale: z
				.number()
				.min(1)
				.max(3)
				.default(2)
				.describe(
					"How hard the instruction is followed: 1 = neutral reading, 2-3 = strong direction (needed for vocal-event tags, adds some harshness). Defaults to 2.",
				),
			maxChunkChars: z
				.number()
				.int()
				.min(40)
				.max(600)
				.default(200)
				.describe(
					"Split long text on sentence boundaries into pieces of at most this many characters, each generated in one pass. Defaults to 200.",
				),
			pauseMs: z
				.number()
				.int()
				.min(0)
				.max(2000)
				.default(400)
				.describe(
					"Milliseconds of silence inserted between sentence pieces and after the final clip. Defaults to 400.",
				),
			cleanMarkdown: z
				.boolean()
				.default(true)
				.describe(
					"Strip markdown, links, URLs, code blocks, emoji and other non-speech formatting before generating. Leave off only for verbatim reading.",
				),
			voiceId: z
				.string()
				.default(BREEZE_TTS_VOICE)
				.describe(
					`Voice to speak with: a name from listVoices. Defaults to "${BREEZE_TTS_VOICE}".`,
				),
			seed: z
				.number()
				.int()
				.optional()
				.describe("RNG seed for reproducible audio."),
			play: z
				.boolean()
				.default(true)
				.describe(
					"Play the generated audio on the local speakers. Leave off to only save the file.",
				),
			background: z
				.boolean()
				.default(false)
				.describe(
					"Submit only and return immediately: the clip generates in the background and plays back in submission order, including the inter-clip silence. Use speechJobs to check progress. Clips estimated beyond the blocking audio budget (~45s of audio) are auto-submitted this way even without this flag.",
				),
		},
	},
	async ({
		text,
		instruction,
		cfgScale,
		maxChunkChars,
		pauseMs,
		cleanMarkdown,
		voiceId,
		seed,
		play,
		background,
	}) => {
		const request = {
			text,
			instruction,
			voiceId,
			cfgScale,
			maxChunkChars,
			pauseMs,
			cleanMarkdown,
			seed,
			play,
			background,
		};
		// auto-background: when the clip is too long to block on safely, degrade
		// to a background submission rather than racing the client's request
		// timeout — the same interface either way via speechJobs
		if (!background) {
			const cleanedForEstimate =
				cleanMarkdown === false ? text : cleanForSpeech(text);
			const estimatedSeconds = Math.round(
				cleanedForEstimate.length / EST_CHARS_PER_SECOND,
			);
			if (estimatedSeconds > BLOCKING_AUDIO_BUDGET_S) {
				const job = submitSpeech(request);
				return {
					content: [
						{
							type: "text" as const,
							text: `Clip too long to block on (est. ~${estimatedSeconds}s of audio) — submitted as background job [${job.id}] (${job.pieces.length} pieces, voice "${voiceId ?? "default"}"). It will generate and play back in order; use speechJobs to poll.`,
						},
					],
				};
			}
		}
		if (background) {
			const job = submitSpeech(request);
			return {
				content: [
					{
						type: "text" as const,
						text: `Speech job [${job.id}] submitted (${job.pieces.length} sentence pieces, voice "${voiceId ?? "default"}")${instruction ? `, direction "${instruction}"` : ""}.\nIt will generate in the background and play back in order. Use speechJobs to check on it.\nNote: background clips are lost if this MCP session ends before they finish.`,
					},
				],
			};
		}
		try {
			const job = await speakText(request);
			if (job.status === "error" || !job.wavPath) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error speaking: ${job.error ?? "unknown failure"}`,
						},
					],
				};
			}
			const direction = instruction ? `, direction "${instruction}"` : "";
			const piecesNote =
				job.pieces.length > 1 ? ` in ${job.pieces.length} sentence pieces` : "";
			return {
				content: [
					{
						type: "text" as const,
						text: `Spoke ${job.audioSeconds}s of audio${piecesNote} with voice "${voiceId ?? "default"}"${direction}.\nSaved: ${job.wavPath}\n${job.playbackNote ?? "Playback was queued."}${job.directiveNote ? `\n${job.directiveNote}` : ""}`,
					},
				],
			};
		} catch (error) {
			log("speak failed:", error);
			return {
				content: [
					{
						type: "text" as const,
						text: `Error speaking: ${error}`,
					},
				],
			};
		}
	},
);

server.registerTool(
	"speechJobs",
	{
		title: "Check speech jobs",
		description:
			"Check the state of recent speech jobs (queued/generating/playing/done/error), including background submissions, with their saved WAV paths. The server keeps the last 30 jobs and evicts the oldest finished ones when it is full; this reports the newest 8, newest first, one line per job.",
		inputSchema: {},
	},
	async () => ({
		content: [{ type: "text" as const, text: describeSpeechJobs() }],
	}),
);

server.registerTool(
	"listVoices",
	{
		title: "List Breeze voices",
		description:
			"List the voices available on the local Breeze TTS server: permanently saved ones and those cached for the current session. Every listed id is a valid voiceId for speak and designVoice is how new ones are added.",
		inputSchema: {},
	},
	async () => {
		try {
			const voices = await listVoiceEntries();
			if (voices.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "The Breeze server has no voices yet; designVoice can create the first one.",
						},
					],
				};
			}
			return {
				content: [
					{
						type: "text" as const,
						text: voices
							.map(
								(v: VoiceEntry) =>
									`- "${v.id}" [${v.saved ? "saved" : "cached"}] ${v.seconds.toFixed(1)}s ref — ${
										v.ref_text.length > 80
											? `${v.ref_text.slice(0, 80)}…`
											: v.ref_text
									}`,
							)
							.join("\n"),
					},
				],
			};
		} catch (error) {
			log("listVoices failed:", error);
			return {
				content: [
					{
						type: "text" as const,
						text: `Error listing voices: ${error}`,
					},
				],
			};
		}
	},
);

server.registerTool(
	"designVoice",
	{
		title: "Design a new Breeze voice",
		description:
			"Design a brand-new voice on the Breeze TTS server from a text description alone - no reference audio needed. " +
			"The server invents a voice to match, speaks a short sample line in it (on the local speakers unless turned down), and (with a name) saves it permanently for later speak calls as voiceId. " +
			"The sample line is stored as the voice's transcript, so keep it natural.",
		inputSchema: {
			description: z
				.string()
				.min(1)
				.describe(
					"Description of the voice to invent, e.g. 'A warm, thoughtful young woman with a clear, calm delivery.'",
				),
			text: z
				.string()
				.optional()
				.describe(
					"What the designed voice should say in its sample. Defaults to a generic intro; a natural, expressive couple of sentences gives the best voice capture.",
				),
			name: z
				.string()
				.optional()
				.describe(
					"Name to save the designed voice under permanently (letters, digits, dash, underscore; max 64 chars). Omit to only hear the sample without saving anything.",
				),
			cfgScale: z
				.number()
				.min(1)
				.max(3)
				.default(2)
				.describe(
					"How hard the description steers the invented voice. Defaults to 2.",
				),
			seed: z
				.number()
				.int()
				.optional()
				.describe("RNG seed for reproducible voice design."),
			play: z
				.boolean()
				.default(true)
				.describe("Play the designed sample on the local speakers."),
		},
	},
	async ({ description, text, name, cfgScale, seed, play }) => {
		try {
			if (name && !VOICE_NAME_RE.test(name)) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: voice name can only use letters, digits, dash and underscore (max 64 chars).",
						},
					],
				};
			}
			const content = cleanForSpeech(
				text ??
					"Hello! I am a brand new voice, invented from a description alone. I hope you like how I sound when I speak.",
			);

			// no voice_id, no reference: the server runs voice design mode,
			// where the instruction describes the voice to invent
			const clip = await generateSpeech([content], {
				instruction: description,
				cfgScale: cfgScale ?? 2,
				seed,
				pauseMs: 400,
				fileStem: "design",
				design: true,
			});

			const notes: string[] = [];
			if (name) {
				try {
					const voice = await registerVoice(
						{ wav: pcmToWav(clip.pcm) },
						content,
						name,
					);
					notes.push(
						`Saved as permanent voice "${voice.id}" (${voice.seconds.toFixed(1)}s reference) - usable as voiceId in speak.`,
					);
				} catch (error) {
					notes.push(
						`The sample spoke, but saving voice "${name}" failed: ${error}`,
					);
				}
			} else {
				notes.push(
					"Pass a name to designVoice to keep it as a reusable voice.",
				);
			}

			if (play === false) {
				notes.push("Playback was skipped for this call.");
			} else {
				notes.push(await playWavFile(clip.wavPath));
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Designed a ${clip.audioSeconds}s sample voice from "${description}".\nSaved: ${clip.wavPath}\n${notes.join(" ")}`,
					},
				],
			};
		} catch (error) {
			log("designVoice failed:", error);
			return {
				content: [
					{
						type: "text" as const,
						text: `Error designing voice: ${error}`,
					},
				],
			};
		}
	},
);

server.registerTool(
	"saveVoice",
	{
		title: "Save a Breeze voice from a WAV",
		description:
			"Register a WAV clip as a reusable voice on the Breeze TTS server so speak can use it as voiceId. The transcript must match the clip's speech exactly. With a name the voice is stored permanently (survives server restarts); without one it is only cached for the current server session. Unnamed voices are keyed by a hash of the clip bytes and their transcript, so registering the same clip twice dedupes to one entry under a v-<hex> id.",
		inputSchema: {
			path: z
				.string()
				.describe(
					"Filesystem path to the reference WAV (any sample rate or channel count), e.g. a clip previously saved by speak.",
				),
			refText: z
				.string()
				.min(1)
				.describe("The exact transcript of the reference clip's speech"),
			name: z
				.string()
				.optional()
				.describe(
					"Name to save the voice under permanently (letters, digits, dash, underscore; max 64 chars). Omit to register as a session-cached voice.",
				),
		},
	},
	async ({ path: wavPath, refText, name }) => {
		try {
			if (name && !VOICE_NAME_RE.test(name)) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: voice name can only use letters, digits, dash and underscore (max 64 chars).",
						},
					],
				};
			}
			const voice = await registerVoice({ file: wavPath }, refText, name ?? "");
			const where = name
				? "and saved permanently"
				: "as a session-cached voice";
			return {
				content: [
					{
						type: "text" as const,
						text: `Voice "${voice.id}" registered ${where}: ${voice.seconds.toFixed(1)}s of reference encoded in ${Math.round(voice.encode_ms)}ms.`,
					},
				],
			};
		} catch (error) {
			log("saveVoice failed:", error);
			return {
				content: [
					{
						type: "text" as const,
						text: `Error registering voice: ${error}`,
					},
				],
			};
		}
	},
);

server.registerTool(
	"deleteVoice",
	{
		title: "Delete a Breeze voice",
		description:
			"Drop a voice from the Breeze TTS server's memory by id (from listVoices). The server keeps any saved voice file on disk on purpose, so a dropped saved voice returns on the next server restart; remove its .breeze file for a permanent deletion.",
		inputSchema: {
			voiceId: z.string().describe("The id of the voice to drop"),
		},
	},
	async ({ voiceId }) => {
		try {
			await deleteVoiceEntry(voiceId);
			return {
				content: [
					{
						type: "text" as const,
						text: `Voice "${voiceId}" dropped from server memory (files on disk are kept by design).`,
					},
				],
			};
		} catch (error) {
			log("deleteVoice failed:", error);
			return {
				content: [
					{
						type: "text" as const,
						text: `Error deleting voice: ${error}`,
					},
				],
			};
		}
	},
);

/// --- default voice bootstrap ---

const wait = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * At startup, make sure the voice speak defaults to (BREEZE_TTS_VOICE,
 * "default") actually exists: wait for the engine (it refuses connections
 * while the model loads), register a provided bootstrap WAV if one is
 * configured, otherwise design a generic voice and save it under the
 * default name. Fire-and-forget: a failure here must never stop the server
 * from coming up.
 */
async function bootstrapDefaultVoice(): Promise<void> {
	const target = BREEZE_TTS_VOICE;
	const file = process.env.BREEZE_TTS_BOOTSTRAP_VOICE;
	const refText = process.env.BREEZE_TTS_BOOTSTRAP_REF_TEXT;
	for (let attempt = 1; attempt <= 60; attempt++) {
		let voices: VoiceEntry[];
		try {
			voices = await listVoiceEntries();
		} catch {
			if (attempt === 1 || attempt % 10 === 0) {
				log(`bootstrap: breeze server not reachable yet (attempt ${attempt})`);
			}
			await wait(2000);
			continue;
		}
		if (voices.some((v) => v.id === target)) {
			log(`bootstrap: voice "${target}" already present`);
			return;
		}
		try {
			if (file) {
				if (!refText) {
					log(
						"bootstrap: BREEZE_TTS_BOOTSTRAP_VOICE needs BREEZE_TTS_BOOTSTRAP_REF_TEXT (the clip's exact transcript)",
					);
					return;
				}
				const voice = await registerVoice({ file }, refText, target);
				log(`bootstrap: registered voice "${voice.id}" from ${file}`);
				return;
			}
			const content =
				"Hello. This is the default voice for this server, designed at first start to be easy to listen to. I will read whatever you send my way.";
			const instruction =
				"A warm, clear female voice with the measured, friendly cadence of a public radio host. Composed and easy to listen to at length.";
			const clip = await generateSpeech([content], {
				instruction,
				cfgScale: 2,
				seed: 42,
				pauseMs: 400,
				fileStem: "bootstrap",
				design: true,
			});
			const voice = await registerVoice({ wav: pcmToWav(clip.pcm) }, content, target);
			log(`bootstrap: designed and saved the default voice "${voice.id}"`);
		} catch (error) {
			log("bootstrap:", error);
		}
		return;
	}
	log(
		"bootstrap: gave up waiting for the breeze server; speak will 404 until a voice named " +
			target +
			" is created (designVoice or saveVoice)",
	);
}

async function main(): Promise<void> {
	void bootstrapDefaultVoice().catch((error) => {
		log("bootstrap failed:", error);
	});
	const args = process.argv.slice(2);
	const httpIndex = args.indexOf("--http");
	if (httpIndex !== -1 || args.includes("--host")) {
		const port = Number(args[httpIndex + 1] ?? "8123");
		if (!Number.isFinite(port) || port <= 0) {
			log("--http expects a port number");
			process.exitCode = 1;
			return;
		}
		const hostIndex = args.indexOf("--host");
		const host = hostIndex !== -1 ? (args[hostIndex + 1] ?? "127.0.0.1") : "127.0.0.1";

		// stateless mode: each request gets a fresh transport; no sessions to
		// leak, any load balancer friendly, curl can drive it directly
		const httpServer = http.createServer(async (req, res) => {
			const url = req.url ?? "";
			if (req.method === "POST" && (url === "/mcp" || url.startsWith("/mcp?"))) {
				try {
					const chunks: Buffer[] = [];
					for await (const chunk of req) chunks.push(chunk as Buffer);
					const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					const transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: undefined,
						enableJsonResponse: true,
					});
					res.on("close", () => {
						void transport.close();
					});
					await server.connect(transport);
					await transport.handleRequest(req, res, body);
				} catch (error) {
					log("http request failed:", error);
					if (!res.headersSent) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: String(error) }));
					}
				}
				return;
			}
			if (req.method === "GET" && url === "/health") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ status: "ok", transport: "streamable-http" }));
				return;
			}
			res.writeHead(405, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "POST /mcp or GET /health" }));
		});

		await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
		log(`streamable http on http://${host}:${port}/mcp`);
		return;
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);
	log("connected over stdio");
}

main().catch((error) => {
	log("fatal:", error);
	process.exitCode = 1;
});
