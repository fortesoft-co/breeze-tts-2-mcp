/**
 * Shared speech core used by both the MCP server (server.ts) and the skill CLI
 * (cli.ts): an ordered speech job pipeline plus machine-wide playback
 * coordination.
 *
 * Design:
 * - Generation is serialized inside this process (Breeze serves one request at
 *   a time; a second concurrent request is rejected with 409).
 * - Playback entries chain through an in-process FIFO, so a turn's utterances
 *   play back in submission order with their trailing silence intact.
 * - Playback is additionally guarded by a machine-wide lock (a bound unix
 *   domain socket), so two separately registered MCP clients - say Zed and
 *   Claude Code - take turns instead of talking over each other. Holder
 *   crashes recover automatically: a dead socket fails to connect, gets
 *   removed and rebound.
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { type SpeechPiece } from "./breezeClient.ts";
import { generateSpeech } from "./breezeClient.ts";
import {
	parseDirectives,
	summarizeDirectiveReport,
} from "./directives.ts";
import { splitIntoChunks } from "./split.ts";
import { cleanForSpeech } from "./textClean.ts";

function log(...parts: unknown[]): void {
	console.error("[breeze-speech]", ...parts);
}

/// --- playback ---

const execFileAsync = promisify(execFile);
const PLAYER_FALLBACKS = ["ffplay", "mpv", "paplay", "aplay"];
let playerPromise: Promise<string | null> | undefined;
// In-process playback FIFO: full lifecycles (lock → spawn → exit → release)
// chain here, but queuing returns immediately so callers are never blocked.
let playbackQueue: Promise<void> = Promise.resolve();
const LOCK_PATH =
	process.env.BREEZE_TTS_PLAYBACK_LOCK ??
	path.join(
		os.tmpdir(),
		`breeze-tts-${process.getuid?.() ?? 0}-playback-lock.sock`,
	);

function playerArgs(player: string, wavPath: string): string[] {
	const name = path.basename(player);
	if (name.startsWith("ffplay")) {
		return ["-nodisp", "-autoexit", "-loglevel", "quiet", wavPath];
	}
	if (name.startsWith("mpv")) {
		return ["--no-video", "--really-quiet", wavPath];
	}
	return [wavPath];
}

async function findPlayer(): Promise<string | null> {
	playerPromise ??= (async () => {
		const candidates = process.env.BREEZE_TTS_PLAYER
			? [process.env.BREEZE_TTS_PLAYER]
			: PLAYER_FALLBACKS;
		for (const candidate of candidates) {
			try {
				if (candidate.includes(path.sep)) {
					await fs.access(candidate, fs.constants.X_OK);
					return candidate;
				}
				const { stdout } = await execFileAsync("which", [candidate]);
				const found = stdout.trim();
				if (found) return found;
			} catch {
				// no such command, keep probing
			}
		}
		return null;
	})();
	return playerPromise;
}

function isLockSocketAlive(): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect(LOCK_PATH);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

/**
 * Bind the machine-wide playback lock. The socket only exists while somebody
 * is actually playing, so a crashed holder is detected by a failed connect and
 * cleaned up here.
 */
async function acquirePlaybackLock(): Promise<net.Server> {
	const deadline = Date.now() + 120_000; // bounded by the longest plausible clip
	for (;;) {
		if (Date.now() > deadline) {
			throw new Error("timed out waiting for the machine-wide playback lock");
		}
		const alive = await isLockSocketAlive();
		if (!alive) {
			try {
				await fs.rm(LOCK_PATH, { force: true });
			} catch {
				// nothing to clean up
			}
			// between the cleanup and this bind a competitor may win; the loop
			// retries on EADDRINUSE
			const held = await new Promise<net.Server | null>((resolve) => {
				const srv = net.createServer();
				srv.once("error", () => resolve(null));
				srv.listen(LOCK_PATH, () => resolve(srv));
			});
			if (held) return held;
		}
		await new Promise((r) => setTimeout(r, 150));
	}
}

/**
 * Queue a WAV for playback and return immediately. The chained lifecycle takes
 * the machine-wide lock, plays, then releases, so entries play back serially
 * with their trailing silence intact - across entries and across processes.
 * `lifecycle` resolves when THIS clip has actually finished playing (spawn
 * exited, lock released), so callers can report the truth instead of a queue
 * promise.
 */
export interface QueuedPlayback {
	message: string;
	lifecycle: Promise<void>;
}

export async function queueWavFile(wavPath: string): Promise<QueuedPlayback> {
	const player = await findPlayer();
	if (!player) {
		return {
			message: `Playback skipped: no audio player found (tried ${PLAYER_FALLBACKS.join(", ")}). Set BREEZE_TTS_PLAYER to one.`,
			lifecycle: Promise.resolve(),
		};
	}
	playbackQueue = playbackQueue.then(async () => {
		const lock = await acquirePlaybackLock();
		try {
			await new Promise<void>((resolve, reject) => {
				const child = spawn(player, playerArgs(player, wavPath), {
					stdio: "ignore",
				});
				child.on("error", reject);
				child.on("exit", (code) =>
					code === 0
						? resolve()
						: reject(
								new Error(
									`${path.basename(player)} exited with code ${code}`,
								),
							),
				);
			});
		} catch (error) {
			// log and swallow: a broken link must never kill the playback chain
			log("playback failed:", error);
		} finally {
			lock.close();
		}
	});
	const lifecycle = playbackQueue;
	log("queued", wavPath);
	return {
		message: `Queued for playback through the local speakers via ${path.basename(player)}.`,
		lifecycle,
	};
}

/** Fire-and-forget queueing for callers that only want the message. */
export async function playWavFile(wavPath: string): Promise<string> {
	const { message, lifecycle } = await queueWavFile(wavPath);
	void lifecycle.catch(() => {});
	return message;
}

/** Test/audit hook: resolves when every queued playback has finished. */
export async function waitPlaybackIdle(): Promise<void> {
	await playbackQueue;
}

/// --- speech jobs ---

export type JobStatus = "queued" | "generating" | "playing" | "done" | "error";

export interface SpeechJob {
	id: string;
	fileStem: string;
	text: string;
	cleanedText: string;
	pieces: SpeechPiece[];
	params: {
		instruction?: string;
		voiceId?: string;
		cfgScale: number;
		seed?: number;
		pauseMs: number;
	};
	play: boolean;
	background: boolean;
	createdAt: number;
	status: JobStatus;
	error?: string;
	wavPath?: string;
	audioSeconds?: number;
	playbackNote?: string;
	playbackLifecycle?: Promise<void>;
	directiveNote?: string;
	trailingPauseMs?: number;
	pieceLabels?: string[];
	transcript?: string;
	savePieces?: boolean;
	normalizePieces?: boolean;
	resolve?: (job: SpeechJob) => void;
}

export interface SpeechRequest {
	text?: string;
	instruction?: string;
	voiceId?: string;
	cfgScale?: number;
	maxChunkChars?: number;
	pauseMs?: number;
	cleanMarkdown?: boolean;
	seed?: number;
	play?: boolean;
	background?: boolean;
}

const JOB_HISTORY_LIMIT = 30;
const speechJobs = new Map<string, SpeechJob>();
let jobSequence = 0;
let pumping = false;

export function newId(): string {
	jobSequence += 1;
	return (
		Math.random().toString(36).slice(2, 6) + (jobSequence % 10000).toString(36)
	);
}

function submitSpeechJob(request: SpeechRequest): SpeechJob {
	const cfgScale = request.cfgScale ?? 2;
	const maxChunkChars = request.maxChunkChars ?? 200;
	const pauseMs = request.pauseMs ?? 400;

	const raw = request.text ?? "";
	const cleanedText =
		request.cleanMarkdown === false ? raw : cleanForSpeech(raw);
	// directives parse on the RAW text (before cleaning), then each segment is
	// cleaned and sentence-split; a segment's pause sits on its FIRST chunk
	// speak is single-voice: {voice:...} directives surface with a redirect
	// to speakScript instead of being silently dropped
	const parsed = parseDirectives(raw, { voiceMode: "ignore" });
	const directiveNote = summarizeDirectiveReport(parsed.report, { singleVoice: true });
	const pieces: SpeechPiece[] = [];
	for (const segment of parsed.segments) {
		const segmentText =
			request.cleanMarkdown === false ? segment.text : cleanForSpeech(segment.text);
		let first = true;
		for (const chunk of splitIntoChunks(segmentText, maxChunkChars)) {
			pieces.push({
				text: chunk,
				...(first && segment.pauseBeforeMs !== undefined
					? { pauseBeforeMs: segment.pauseBeforeMs }
					: {}),
			});
			first = false;
		}
	}

	const job: SpeechJob = {
		id: newId(),
		fileStem: "speak",
		text: request.text ?? "",
		cleanedText,
		transcript: cleanedText,
		pieces,
		...(directiveNote ? { directiveNote } : {}),
		...(parsed.trailingPauseMs !== undefined
			? { trailingPauseMs: parsed.trailingPauseMs }
			: {}),
		params: {
			instruction: request.instruction,
			voiceId: request.voiceId,
			cfgScale,
			seed: request.seed,
			pauseMs,
		},
		play: request.play ?? true,
		background: request.background ?? false,
		createdAt: Date.now(),
		status: "queued",
	};

	// bounded history: drop oldest finished entries
	if (speechJobs.size >= JOB_HISTORY_LIMIT) {
		for (const [id, existing] of speechJobs) {
			if (existing.status === "done" || existing.status === "error") {
				speechJobs.delete(id);
			}
		}
	}
	speechJobs.set(job.id, job);
	return job;
}

/** Compiled pieces + params, ready for the job pipeline (no re-parsing). */
	export interface PiecesSubmission {
	pieces: SpeechPiece[];
	directiveNote?: string;
	trailingPauseMs?: number;
	fileStem?: string;
	params: {
		instruction?: string;
		voiceId?: string;
		cfgScale: number;
		seed?: number;
		pauseMs: number;
	};
	play?: boolean;
	/** per-piece voice labels for filenames and the manifest */
	pieceLabels?: string[];
	/** the input transcript, saved alongside the output */
	transcript?: string;
	/** per-piece wav files + manifest in a dated job folder */
	savePieces?: boolean;
	/** light gain-only RMS matching across pieces */
	normalizePieces?: boolean;
}

function submitPiecesJob(submission: PiecesSubmission): SpeechJob {
	const job: SpeechJob = {
		id: newId(),
		fileStem: submission.fileStem ?? "script",
		text: submission.pieces.map((p) => p.text).join(" "),
		cleanedText: submission.pieces.map((p) => p.text).join(" "),
		pieces: submission.pieces,
		...(submission.directiveNote ? { directiveNote: submission.directiveNote } : {}),
		...(submission.trailingPauseMs !== undefined
			? { trailingPauseMs: submission.trailingPauseMs }
			: {}),
		params: submission.params,
		play: submission.play ?? true,
		...(submission.pieceLabels ? { pieceLabels: submission.pieceLabels } : {}),
		...(submission.transcript !== undefined ? { transcript: submission.transcript } : {}),
		...(submission.savePieces !== undefined ? { savePieces: submission.savePieces } : {}),
		...(submission.normalizePieces !== undefined ? { normalizePieces: submission.normalizePieces } : {}),
		background: false,
		createdAt: Date.now(),
		status: "queued",
	};
	if (speechJobs.size >= JOB_HISTORY_LIMIT) {
		for (const [id, existing] of speechJobs) {
			if (existing.status === "done" || existing.status === "error") {
				speechJobs.delete(id);
			}
		}
	}
	speechJobs.set(job.id, job);
	return job;
}

/** Submit compiled script pieces; the promise resolves at queue end (playing). */
export function speakScriptPieces(
	submission: PiecesSubmission,
): Promise<SpeechJob> {
	const job = submitPiecesJob(submission);
	const promise = new Promise<SpeechJob>((resolve) => {
		job.resolve = resolve;
	});
	void pumpSpeechQueue().catch((error) => log("pump died:", error));
	return promise;
}

/** Fire-and-forget compiled submission (background scripts). */
export function submitScriptPieces(submission: PiecesSubmission): SpeechJob {
	const job = submitPiecesJob(submission);
	void pumpSpeechQueue();
	return job;
}

async function runJob(job: SpeechJob): Promise<void> {
	if (job.pieces.length === 0) {
		job.status = "error";
		job.error =
			"no speakable text was provided (it may have been only markdown or code, which are stripped before generation)";
		job.resolve?.(job);
		return;
	}
	job.status = "generating";
	try {
		const clip = await generateSpeech(job.pieces, {
			instruction: job.params.instruction,
			voiceId: job.params.voiceId,
			cfgScale: job.params.cfgScale,
			seed: job.params.seed,
			pauseMs: job.params.pauseMs,
			trailingPauseMs: job.trailingPauseMs,
			fileStem: job.fileStem,
			savePieces: job.savePieces,
			normalizePieces: job.normalizePieces,
			pieceLabels: job.pieceLabels,
			transcript: job.transcript,
		});
		job.wavPath = clip.wavPath;
		job.audioSeconds = clip.audioSeconds;
		// the call returns when generation ends; playback is chained on the FIFO
		// and the job stays "playing" until this clip has actually finished —
		// speechJobs can then report the truth instead of a queue promise
		let queued: QueuedPlayback;
		if (job.play) {
			queued = await queueWavFile(clip.wavPath);
		} else {
			queued = {
				message: "Playback was skipped for this call.",
				lifecycle: Promise.resolve(),
			};
		}
		job.playbackNote = queued.message;
		job.playbackLifecycle = queued.lifecycle;
		job.status = "playing";
		// truth for speechJobs: the job stays "playing" until the clip has
		// actually finished — but the resolve fires NOW, at generation/queue
		// end. A blocking call must not hold the agent for the playback itself
		// (MCP clients have request timeouts); the audio continues on the FIFO
		// after the call returns.
		void job.playbackLifecycle.then(
			() => {
				job.status = "done";
			},
			() => {
				job.status = "done";
			},
		);
		job.resolve?.(job);
	} catch (error) {
		job.status = "error";
		job.error = String(error);
		log("job", job.id, "failed:", error);
		job.resolve?.(job);
	}
}

async function pumpSpeechQueue(): Promise<void> {
	if (pumping) return;
	pumping = true;
	try {
		for (;;) {
			const next = [...speechJobs.values()].find((j) => j.status === "queued");
			if (!next) return;
			await runJob(next);
		}
	} finally {
		pumping = false;
	}
}

/** Submit a job and get a promise resolving at the terminal state */
export function speakText(request: SpeechRequest): Promise<SpeechJob> {
	const job = submitSpeechJob(request);
	const promise = new Promise<SpeechJob>((resolve) => {
		job.resolve = resolve;
	});
	void pumpSpeechQueue().catch((error) => log("pump died:", error));
	return promise;
}

/** Submit and return immediately (background mode) */
export function submitSpeech(request: SpeechRequest): SpeechJob {
	const job = submitSpeechJob(request);
	void pumpSpeechQueue();
	return job;
}

export function describeSpeechJobs(): string {
	const jobs = [...speechJobs.values()].slice(-8).reverse();
	if (jobs.length === 0) return "No speech jobs in this session.";
	return jobs
		.map((j) => {
			const age = Math.round((Date.now() - j.createdAt) / 1000);
			const status = j.status === "error" ? `error: ${j.error}` : j.status;
			const clip =
				j.wavPath && j.audioSeconds
					? ` → ${j.audioSeconds}s: ${j.wavPath}`
					: "";
			return `- [${j.id}] ${status} (${age}s ago, ${j.pieces.length} pieces, voice "${j.params.voiceId ?? "default"}"${j.background ? ", background" : ""})${clip}`;
		})
		.join("\n");
}
