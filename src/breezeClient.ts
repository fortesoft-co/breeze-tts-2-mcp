// HTTP client for Breeze-TTS-2.cpp (docs: docs/server.md in the Breeze repo)

import fs from "node:fs/promises";
import path from "node:path";

export const BREEZE_TTS_URL =
	process.env.BREEZE_TTS_URL ?? "http://127.0.0.1:1923";
export const BREEZE_TTS_VOICE = process.env.BREEZE_TTS_VOICE ?? "default";
export const VOICE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const SAMPLE_RATE = 24000; // mono signed 16-bit little endian
const GENERATION_ATTEMPTS = 3; // server returns 409 busy while another request uses the GPU
const MIN_TIMEOUT_MS = 60_000;
const TIMEOUT_MS_PER_CHAR = 100; // ~1.2x realtime generation, generous headroom

export interface SpeechParams {
	text: string;
	instruction?: string;
	voiceId?: string;
	cfgScale: number;
	seed?: number;
}

export async function postWithRetry(
	path: string,
	body: FormData | URLSearchParams | string,
	timeoutMs: number,
): Promise<Response> {
	let res: Response | undefined;
	for (let attempt = 1; attempt <= GENERATION_ATTEMPTS; attempt++) {
		try {
			res = await fetch(`${BREEZE_TTS_URL}${path}`, {
				method: "POST",
				body,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			// connection refused or timeout: the engine may be restarting (it
			// refuses connections while the model loads) — same backoff as the
			// busy case, then a clean verdict for the caller instead of raw
			// Node fetch noise
			if (attempt === GENERATION_ATTEMPTS) break;
			await new Promise((r) => setTimeout(r, 1500 * attempt));
			continue;
		}
		if (res.status !== 409 || attempt === GENERATION_ATTEMPTS) break;
		await new Promise((r) => setTimeout(r, 1500 * attempt));
	}
	if (!res) {
		throw new Error(
			`Breeze server unreachable at ${BREEZE_TTS_URL} (is breeze-server running?)`,
		);
	}
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
	}
	return res;
}

export function pcmToWav(
	pcm: Buffer,
	sampleRate = SAMPLE_RATE,
	channels = 1,
): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16); // PCM chunk size
	header.writeUInt16LE(1, 20); // PCM format
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
	header.writeUInt16LE(channels * 2, 32); // block align
	header.writeUInt16LE(16, 34); // bits per sample
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

export interface GeneratedClip {
	pcm: Buffer;
	wavPath: string;
	audioSeconds: number;
	pieceCount: number;
}

/**
 * Generate speech for `pieces` (already sentence-chunked by the caller),
 * joining the streamed PCM with silence gaps and saving a WAV to the work dir.
 */
export interface SpeechPiece {
	text: string;
	/** directive silence BEFORE this piece; replaces the standard beat on its boundary */
	pauseBeforeMs?: number;
	design?: boolean;
	/** per-piece delivery; undefined inherits the call-level instruction */
	instruction?: string;
	/** per-piece voice; undefined inherits the call-level voiceId */
	voiceId?: string;
}

export async function generateSpeech(
	pieces: (string | SpeechPiece)[],
	options: Omit<SpeechParams, "text"> & {
		pauseMs: number;
		/** directive pause that extends the final beat */
		trailingPauseMs?: number;
		fileStem: string;
		design?: boolean;
	},
): Promise<GeneratedClip> {
	const { pauseMs, fileStem } = options;
	const normalized: SpeechPiece[] = pieces.map((piece) =>
		typeof piece === "string" ? { text: piece } : piece,
	);
	const buffers: Buffer[] = [];
	const silenceFor = (ms: number): Buffer =>
		Buffer.alloc(Math.round((ms / 1000) * SAMPLE_RATE) * 2);

	// a leading {pause} opens the render with silence
	if (normalized[0].pauseBeforeMs) {
		buffers.push(silenceFor(normalized[0].pauseBeforeMs));
	}

	for (let index = 0; index < normalized.length; index++) {
		const piece = normalized[index];
		const chunk = piece.text;
		const form = new URLSearchParams();
		form.set("text", chunk);
		// per-piece delivery and voice win over the call-level defaults; a
		// different instruction or voice per piece is its own generation pass
		const pieceInstruction = piece.instruction ?? options.instruction;
		const pieceVoiceId = piece.voiceId ?? options.voiceId ?? BREEZE_TTS_VOICE;
		// design mode is the server's "no voice_id, no reference" case: voice_id
		// must be omitted or the generated clip is a direction-clone of whatever
		// voice the id points at instead of an invented voice
		if (!options.design) form.set("voice_id", pieceVoiceId);
		if (pieceInstruction) form.set("instruction", pieceInstruction);
		form.set("cfg_scale", String(options.cfgScale));
		form.set("split_chars", "0"); // chunking is ours; one pass per piece
		if (options.seed !== undefined) form.set("seed", String(options.seed));

		const res = await postWithRetry(
			"/v1/audio/speech",
			form,
			MIN_TIMEOUT_MS + chunk.length * TIMEOUT_MS_PER_CHAR,
		);
		let pcm = Buffer.from(await res.arrayBuffer());
		if (pcm.length % 2) pcm = pcm.subarray(0, pcm.length - 1);
		if (pcm.length === 0) {
			throw new Error(
				`piece ${index + 1} of ${normalized.length} returned no audio (the stream may have been cut short)`,
			);
		}
		buffers.push(pcm);
		const next = normalized[index + 1];
		// the gap after this piece: the NEXT piece's directive pause when set,
		// otherwise the standard beat; the last piece gets the beat plus any
		// trailing directive pause
		const gapMs = next
			? (next.pauseBeforeMs ?? pauseMs)
			: pauseMs + (options.trailingPauseMs ?? 0);
		buffers.push(silenceFor(gapMs));
	}

	// piece PCM with all gaps already interleaved
	const pcm = Buffer.concat(buffers);

	const workDir = resolveWorkDir();
	await fs.mkdir(workDir, { recursive: true });
	const wavPath = path.join(
		workDir,
		`${fileStem}-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`,
	);
	await fs.writeFile(wavPath, pcmToWav(pcm));

	return {
		pcm,
		wavPath,
		audioSeconds: Number((pcm.length / 2 / SAMPLE_RATE).toFixed(1)),
		pieceCount: buffers.length,
	};
}

function resolveWorkDir(): string {
	const configured = process.env.BREEZE_TTS_WORK_DIR;
	if (configured) return path.resolve(configured);
	return path.resolve("./breeze-tts-work");
}

/// --- voice lifecycle ---

export interface VoiceEntry {
	id: string;
	frames: number;
	seconds: number;
	encode_ms: number;
	saved: boolean;
	ref_text: string;
}

function isVoiceEntry(value: unknown): value is VoiceEntry {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === "string" &&
		typeof v.frames === "number" &&
		typeof v.seconds === "number" &&
		typeof v.encode_ms === "number" &&
		typeof v.saved === "boolean" &&
		typeof v.ref_text === "string"
	);
}

export async function listVoiceEntries(): Promise<VoiceEntry[]> {
	const res = await fetch(`${BREEZE_TTS_URL}/v1/voices`, {
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(
			`listing voices failed: HTTP ${res.status}: ${body.slice(0, 300)}`,
		);
	}
	const parsed: unknown = await res.json();
	if (!Array.isArray(parsed))
		throw new Error("unrecognized voice list response");
	return parsed.filter(isVoiceEntry);
}

export async function deleteVoiceEntry(
	voiceId: string,
): Promise<VoiceEntry | undefined> {
	const res = await fetch(
		`${BREEZE_TTS_URL}/v1/voices/${encodeURIComponent(voiceId)}`,
		{ method: "DELETE", signal: AbortSignal.timeout(15_000) },
	);
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
	}
	const body = (await res.json()) as { deleted?: string; file_kept?: boolean };
	return {
		id: voiceId,
		frames: 0,
		seconds: 0,
		encode_ms: 0,
		saved: Boolean(body.file_kept),
		ref_text: "",
	};
}

/**
 * Register a WAV (buffer or file) as a permanent named voice on the server.
 */
export async function registerVoice(
	source: { wav: Buffer } | { file: string },
	refText: string,
	name: string,
): Promise<VoiceEntry> {
	if (name !== "" && !VOICE_NAME_RE.test(name)) {
		throw new Error(
			"voice name can only use letters, digits, dash and underscore (max 64 chars)",
		);
	}
	let audio: Buffer;
	if ("wav" in source) {
		audio = source.wav;
	} else {
		audio = await fs.readFile(source.file);
		if (
			audio.length < 44 ||
			audio.subarray(0, 4).toString("latin1") !== "RIFF" ||
			audio.subarray(8, 12).toString("latin1") !== "WAVE"
		) {
			throw new Error("not a WAV file; the server needs WAV reference audio");
		}
	}
	const form = new FormData();
	form.append(
		"ref_audio",
		new Blob([audio], { type: "audio/wav" }),
		"reference.wav",
	);
	form.append("ref_text", refText);
	if (name) form.append("name", name);
	const res = await postWithRetry("/v1/voices", form, 120_000);
	const parsed: unknown = await res.json();
	if (!isVoiceEntry(parsed))
		throw new Error("unrecognized voice registration response");
	return parsed;
}
