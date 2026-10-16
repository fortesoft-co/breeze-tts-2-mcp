#!/usr/bin/env node
/**
 * breeze-speak CLI — the same speech core the MCP server uses, runnable from a
 * shell. Skills that need a voice can invoke this without an MCP host.
 *
 * Usage:
 *   npx tsx src/cli.ts --text "Hello there." --instruction "Calm and clear."
 *   node dist/src/cli.js --text "..." [--voice default] [--cfg-scale 2]
 *        [--max-chunk-chars 200] [--pause-ms 400] [--no-clean] [--seed 42]
 *        [--no-play] [--background]
 */

import {
	describeSpeechJobs,
	type SpeechRequest,
	speakText,
	submitSpeech,
} from "./speech.ts";

interface ParsedArgs {
	request: SpeechRequest;
	jobs: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
	const request: SpeechRequest = {};
	let jobs = false;

	const setNumber = (
		key: "cfgScale" | "maxChunkChars" | "pauseMs" | "seed",
		value: string,
	): void => {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) {
			throw new Error(`${key} expects a number, got: ${value}`);
		}
		request[key === "seed" ? "seed" : key] = parsed;
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const value = argv[index + 1];
		switch (arg) {
			case "--text":
				request.text = value ?? "";
				index++;
				break;
			case "--instruction":
				request.instruction = value;
				index++;
				break;
			case "--voice":
				request.voiceId = value;
				index++;
				break;
			case "--cfg-scale":
				setNumber("cfgScale", value ?? "");
				index++;
				break;
			case "--max-chunk-chars":
				setNumber("maxChunkChars", value ?? "");
				index++;
				break;
			case "--pause-ms":
				setNumber("pauseMs", value ?? "");
				index++;
				break;
			case "--seed":
				setNumber("seed", value ?? "");
				index++;
				break;
			case "--no-clean":
				request.cleanMarkdown = false;
				break;
			case "--no-play":
				request.play = false;
				break;
			case "--background":
				request.background = true;
				break;
			case "--jobs":
				jobs = true;
				break;
			case "--help":
			case "-h":
				console.log(
					"Usage: breeze-speak --text TEXT [--instruction DIR] [--voice ID] [--cfg-scale N]\n" +
						"                   [--max-chunk-chars N] [--pause-ms N] [--seed N]\n" +
						"                   [--no-clean] [--no-play] [--background] [--jobs]",
				);
				process.exit(0);
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}
	return { request, jobs };
}

async function main(): Promise<void> {
	const { request, jobs } = parseArgs(process.argv.slice(2));

	if (jobs) {
		console.log(describeSpeechJobs());
		return;
	}
	if (!request.text) {
		console.error("Error: --text is required");
		process.exitCode = 1;
		return;
	}

	if (request.background) {
		const job = submitSpeech(request);
		console.log(
			`Speech job [${job.id}] submitted (${job.pieces.length} sentence pieces) — generating in the background and playing in order.`,
		);
		return;
	}

	const job = await speakText(request);
	if (job.status === "error" || !job.wavPath) {
		console.error(`Error speaking: ${job.error ?? "unknown failure"}`);
		process.exitCode = 1;
		return;
	}
	const piecesNote =
		job.pieces.length > 1 ? ` in ${job.pieces.length} sentence pieces` : "";
	console.log(
		`Spoke ${job.audioSeconds}s of audio${piecesNote}.\nSaved: ${job.wavPath}\n${job.playbackNote ?? "Playback was queued."}${job.directiveNote ? `\\n${job.directiveNote}` : ""}`,
	);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
