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
		/** write per-piece wavs + transcript + manifest into a job folder */
		savePieces?: boolean;
		/** light RMS matching across pieces (gain-only, capped) */
		normalizePieces?: boolean;
		/** per-piece voice labels for filenames and the manifest */
		pieceLabels?: string[];
		/** the input transcript, saved alongside the output */
		transcript?: string;
	},
): Promise<GeneratedClip> {
	const { pauseMs, fileStem } = options;
	const normalized: SpeechPiece[] = pieces.map((piece) =>
		typeof piece === "string" ? { text: piece } : piece,
	);
	const silenceFor = (ms: number): Buffer =>
		Buffer.alloc(Math.round((ms / 1000) * SAMPLE_RATE) * 2);

	// silence actually inserted before each piece: a leading directive pause,
	// then the gap computed from each piece's tail
	const gapBefore: number[] = new Array(normalized.length + 1).fill(pauseMs);
	if (normalized[0].pauseBeforeMs) gapBefore[0] = normalized[0].pauseBeforeMs;

	const piecePcm: Buffer[] = [];
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
		piecePcm.push(pcm);
		if (index + 1 < normalized.length) {
			gapBefore[index + 1] = normalized[index + 1].pauseBeforeMs ?? pauseMs;
		} else {
			gapBefore[index + 1] = pauseMs + (options.trailingPauseMs ?? 0);
		}
	}
	// gapBefore[normalized.length] is the trailing beat

	// light level matching: gain-only toward the median piece RMS, capped at
	// about ±4dB — intended dynamics (whispers, fades) keep most of their
	// shape, over-loud pieces get pulled back. No compression.
	if (options.normalizePieces && piecePcm.length > 1) {
		const rmsValues = piecePcm.map((pcm) => rms16(pcm)).filter((r) => r > 100);
		if (rmsValues.length > 1) {
			const sorted = [...rmsValues].sort((a, b) => a - b);
			const target = sorted[Math.floor(sorted.length / 2)];
			for (let i = 0; i < piecePcm.length; i++) {
				const rms = rms16(piecePcm[i]);
				if (rms <= 100) continue;
				scale16(piecePcm[i], Math.min(1.6, Math.max(0.63, target / rms)));
			}
		}
	}

	// interleave: silence before each piece + the trailing beat
	const joinedParts: Buffer[] = [];
	for (let index = 0; index < piecePcm.length; index++) {
		joinedParts.push(silenceFor(gapBefore[index]));
		joinedParts.push(piecePcm[index]);
	}
	joinedParts.push(silenceFor(gapBefore[normalized.length]));
	const pcm = Buffer.concat(joinedParts);

	// layout: <workDir>/<YYYY-MM-DD>/ and script jobs get a subfolder
	const day = new Date();
	const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const workDir = resolveWorkDir();
	const baseDir = path.join(workDir, dayKey);
	const jobFolder = options.savePieces
		? path.join(baseDir, `${fileStem}-${stamp}`)
		: undefined;
	await fs.mkdir(jobFolder ?? baseDir, { recursive: true });
	const wavPath = options.savePieces
		? path.join(jobFolder as string, `${fileStem}.wav`)
		: path.join(baseDir, `${fileStem}-${stamp}.wav`);
	await fs.writeFile(wavPath, pcmToWav(pcm));

	// per-piece files + manifest for script jobs: the folder is a
	// self-describing performance that can be re-joined after a retake
	const pieceFiles: string[] = [];
	if (options.savePieces && jobFolder) {
		const manifestPieces: Array<Record<string, unknown>> = [];
		for (let index = 0; index < piecePcm.length; index++) {
			const label = (options.pieceLabels?.[index] ?? "narrator").replace(
				/[^a-z0-9_-]/gi,
				"_",
			);
			const pieceFile = `piece-${String(index + 1).padStart(2, "0")}-${label.slice(0, 40)}.wav`;
			const piecePath = path.join(jobFolder, pieceFile);
			await fs.writeFile(piecePath, pcmToWav(piecePcm[index]));
			pieceFiles.push(piecePath);
			manifestPieces.push({
				file: pieceFile,
				voice: options.pieceLabels?.[index] ?? "narrator",
				gapBeforeMs: gapBefore[index],
			});
		}
		const manifest = {
			kind: "speakScript",
			createdAt: new Date().toISOString(),
			joinedFile: `${fileStem}.wav`,
			pauseMs,
			trailingPauseMs: options.trailingPauseMs ?? 0,
			pieces: manifestPieces,
		};
		await fs.writeFile(path.join(jobFolder, "manifest.json"), JSON.stringify(manifest, null, 2));
	}

	if (options.transcript !== undefined) {
		const transcriptPath = jobFolder
			? path.join(jobFolder, "transcript.txt")
			: path.join(baseDir, `${fileStem}-${stamp}.txt`);
		await fs.writeFile(transcriptPath, options.transcript);
	}

	return {
		pcm,
		wavPath,
		audioSeconds: Number((pcm.length / 2 / SAMPLE_RATE).toFixed(1)),
		pieceCount: normalized.length,
		...(pieceFiles.length > 0 ? { pieceFiles } : {}),
		...(jobFolder ? { jobFolder } : {}),
	};
}

function rms16(pcm: Buffer): number {
	let sum = 0;
	const samples = Math.floor(pcm.length / 2);
	for (let i = 0; i < samples; i++) {
		const s = pcm.readInt16LE(i * 2);
		sum += s * s;
	}
	return samples === 0 ? 0 : Math.sqrt(sum / samples);
}

function scale16(pcm: Buffer, gain: number): void {
	const samples = Math.floor(pcm.length / 2);
	for (let i = 0; i < samples; i++) {
		const scaled = Math.round(pcm.readInt16LE(i * 2) * gain);
		pcm.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), i * 2);
	}
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
