// Cross-process playback lock test (machine-wide, no actual sound).
// Run: npx tsx test/playback-lock.test.ts

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO = new URL("..", import.meta.url).pathname;

// a fixed lock path for this test, isolated from runtime use — must be set
// BEFORE importing the speech core, which freezes these at module load
const TEST_LOCK = path.join(
	os.tmpdir(),
	`breeze-tts-lock-test-${process.getuid?.() ?? 0}.sock`,
);
process.env.BREEZE_TTS_PLAYBACK_LOCK = TEST_LOCK;
process.env.BREEZE_TTS_PLAYER = "/bin/true"; // instant exit, no sound
const { playWavFile, waitPlaybackIdle } = await import("../src/speech.ts");

function isSocketBound(sockPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect(sockPath);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

async function waitForBind(sockPath: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await isSocketBound(sockPath)) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("holder never bound the test lock");
}

async function timedPlay(label: string): Promise<number> {
	const started = Date.now();
	await playWavFile(path.join(REPO, "breeze-tts-work", "x.wav"));
	await waitPlaybackIdle(); // full lifecycle: lock acquired, child exited, lock released
	const took = Date.now() - started;
	console.log(`${label}: ${took}ms`);
	return took;
}

async function main(): Promise<void> {
	await fs.rm(TEST_LOCK, { force: true });
	await fs.mkdir(path.join(REPO, "breeze-tts-work"), { recursive: true });
	await fs.writeFile(path.join(REPO, "breeze-tts-work", "x.wav"), "x");

	// 1. lock free → fast
	const free = await timedPlay("free lock");
	if (free > 2000)
		throw new Error(`expected fast free playback, took ${free}ms`);

	// 2. another process holds the lock → we wait for its release
	const hold = 2000;
	const holder = execFileAsync("node", [
		"-e",
		`const net=require("net");const s=net.createServer();s.once("error",()=>{});s.listen(${JSON.stringify(TEST_LOCK)},()=>setTimeout(()=>s.close(()=>process.exit(0)),${hold}));`,
	]);
	await waitForBind(TEST_LOCK, 3000); // no race: the holder is REALLY bound first
	const contended = await timedPlay("contended");
	if (contended < hold - 500) {
		throw new Error(
			`playback did not wait for the other process: ${contended}ms < hold ${hold}ms`,
		);
	}
	if (contended < hold + 400) {
		throw new Error(
			`no handoff gap after a contended lock: ${contended}ms ≈ hold ${hold}ms — expected ~750ms of dead air`,
		);
	}
	await holder.catch(() => {});

	// 3. stale socket file (crashed holder) → recovers instantly
	await fs.writeFile(TEST_LOCK, ""); // dead file, no listener
	const afterCrash = await timedPlay("after crashed holder");
	if (afterCrash > 2000) {
		throw new Error(`stale lock did not recover: ${afterCrash}ms`);
	}

	await fs.rm(`${REPO}/breeze-tts-work`, { recursive: true, force: true });
	console.log("LOCK_TEST_OK");
}

main().catch((error) => {
	console.error("LOCK TEST FAILED:", error);
	process.exitCode = 1;
});
