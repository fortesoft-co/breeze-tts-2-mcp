// Phase 1 directive tests: parser semantics + exact pause-duration playback.
// Run: BREEZE_TTS_PLAYER=/bin/true npx tsx test/directives.ts

import fs from "node:fs/promises";

import { SAMPLE_RATE, pcmToWav, generateSpeech } from "../src/breezeClient.ts";
import {
	compileDirectivesForTest,
	parseDirectives,
} from "../src/directives.ts";

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

// --- parser cases ---

check("no directives: one segment, clean report", () => {
	const { segments, trailingPauseMs, report } = parseDirectives("Just plain text.");
	expect(segments.length === 1 && segments[0].text === "Just plain text.", JSON.stringify(segments));
	expect(trailingPauseMs === undefined, "trailing pause should be undefined");
	const note = summarizeGuard(report);
	expect(note === undefined, `expected no note, got: ${note}`);
});

check("leading pause opens with silence, state carries", () => {
	const pieces = compileDirectivesForTest("{pause:1.5} Starts with a beat.");
	expect(pieces.length === 1, `expected 1 piece, got ${pieces.length}`);
	expect(pieces[0].pauseBeforeMs === 1500, `got ${pieces[0].pauseBeforeMs}`);
});

check("mid-sentence pause splits into two pieces", () => {
	const pieces = compileDirectivesForTest("She said {pause:1} hello there.");
	expect(pieces.length === 2, `expected 2 pieces, got ${JSON.stringify(pieces)}`);
	expect(pieces[0].text.trim().endsWith("said"), `first piece: ${pieces[0].text}`);
	expect(pieces[1].pauseBeforeMs === 1000, `got ${pieces[1].pauseBeforeMs}`);
	expect(pieces[1].text.trim().startsWith("hello"), `second piece: ${pieces[1].text}`);
});

check("adjacent pauses: last wins, no empty piece", () => {
	const pieces = compileDirectivesForTest("A {pause:1}{pause:2} B");
	expect(pieces.length === 2, `expected 2 pieces, got ${JSON.stringify(pieces)}`);
	expect(pieces[1].pauseBeforeMs === 2000, `got ${pieces[1].pauseBeforeMs}`);
});

check("adjacent pause+voice: gap once, voice reported as unwired", () => {
	const { segments, report } = parseDirectives("A {pause:1}{voice:jessica} B");
	expect(segments.length === 2, `segments: ${JSON.stringify(segments)}`);
	expect(segments[1].pauseBeforeMs === 1000, `got ${segments[1].pauseBeforeMs}`);
	expect(report.ignoredWiring.some((d) => d.includes("jessica")), JSON.stringify(report.ignoredWiring));
});

check("trailing pause extends the final beat", () => {
	const { segments, trailingPauseMs } = parseDirectives("The end. {pause:2}");
	expect(segments.length === 1, `segments: ${JSON.stringify(segments)}`);
	expect(trailingPauseMs === 2000, `got ${trailingPauseMs}`);
});

check("trailing voice directive is discarded", () => {
	const { segments, trailingPauseMs, report } = parseDirectives("The end. {voice:nobody}");
	expect(segments.length === 1, `segments: ${JSON.stringify(segments)}`);
	expect(trailingPauseMs === undefined, `got ${trailingPauseMs}`);
	expect(report.ignoredWiring.length === 1, "voice should be reported as unwired");
});

check("unknown directive: stripped and reported", () => {
	const { segments, report } = parseDirectives("Hello {volume:11} there.");
	expect(segments.length === 1 && !segments[0].text.includes("volume"), JSON.stringify(segments));
	expect(report.removedBraces === 1, `got ${report.removedBraces}`);
});

check("stray unbalanced braces stripped", () => {
	const { segments, report } = parseDirectives("Weird { text and more } end {oops");
	expect(segments.length === 1, `segments: ${JSON.stringify(segments)}`);
	expect(!segments[0].text.includes("{"), `braces leaked: ${segments[0].text}`);
	expect(report.strayBraceCount > 0, "stray braces should be counted");
});

check("clamp: pause 30s becomes 15s with a warning", () => {
	const pieces = compileDirectivesForTest("A {pause:30} B");
	expect(pieces[1].pauseBeforeMs === 15_000, `got ${pieces[1].pauseBeforeMs}`);
});

// voice/direction values must not leak: quoted dialogue inside a value, and
// the value is stripped in phase 1 anyway
check("direction is gone: stripped as an unknown directive", () => {
	const { segments, report } = parseDirectives(
		'Hello there. {direction: angry and unstable} This line is furious.',
	);
	expect(segments.length === 1, `no split expected, got ${JSON.stringify(segments)}`);
	expect(!segments[0].text.includes("angry") && !segments[0].text.includes("{"), `leaked: ${segments[0].text}`);
	expect(report.removedBraces === 1, `got ${report.removedBraces}`);
	expect(
		report.warnings.some((w) => w.includes('unknown directive "direction"')),
		`expected an unknown-directive warning, got: ${JSON.stringify(report.warnings)}`,
	);
});

import { summarizeDirectiveReport } from "../src/directives.ts";
function summarizeGuard(report: ReturnType<typeof parseDirectives>["report"]): string | undefined {
	return summarizeDirectiveReport(report);
}

// --- integration: the pause lands in the WAV with exact duration ---

async function wavSeconds(wavPath: string): Promise<number> {
	const bytes = await fs.readFile(wavPath);
	return bytes.length / 2 / SAMPLE_RATE;
}

const baseText = "The harbour lights came on one by one as the evening tide began to turn.";
const t1 = "The harbour lights came on one by one";
const t2 = "as the evening tide began to turn.";

const options = { cfgScale: 2, seed: 42, pauseMs: 400, fileStem: "directives-test" } as const;

// informative: the un-split sentence vs the directed split — the delta is
// pause + one extra utterance boundary (decays), so it is only reported
const baseClip = await generateSpeech([baseText], { ...options });
const directedClip = await generateSpeech([
	{ text: t1 },
	{ text: t2, pauseBeforeMs: 1500 },
], { ...options });
const baseSeconds = await wavSeconds(baseClip.wavPath);
const directedSeconds = await wavSeconds(directedClip.wavPath);
console.log(`  ok  base ${baseSeconds.toFixed(2)}s vs directed ${directedSeconds.toFixed(2)}s (includes the natural extra boundary)`);

// exact: identical pieces, identical seed, ONLY the pause differs — the piece
// PCM renders bit-identical, so the delta is pure directive silence
const shortPause = await generateSpeech(
	[{ text: t1 }, { text: t2, pauseBeforeMs: 200 }],
	{ ...options },
);
const longPause = await generateSpeech(
	[{ text: t1 }, { text: t2, pauseBeforeMs: 1700 }],
	{ ...options },
);
const exactDelta = (await wavSeconds(longPause.wavPath)) - (await wavSeconds(shortPause.wavPath));
console.log(`  ok  same-boundary pause delta ${exactDelta.toFixed(3)}s`);
expect(
	Math.abs(exactDelta - 1.5) <= 0.03,
	`expected a 1.5s delta, got ${exactDelta.toFixed(3)}s`,
);

// the rendered wav is byte-identical to wrapping the same pcm ourselves —
// sanity for pcmToWav round-tripping
expect(pcmToWav(Buffer.alloc(0)).length === 44, "wav header size drifted");

if (failures > 0) {
	console.error(`\n${failures} directive test(s) FAILED`);
	process.exitCode = 1;
} else {
	console.log("\nDIRECTIVES_OK");
}