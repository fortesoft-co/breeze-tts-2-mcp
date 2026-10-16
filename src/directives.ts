// Directive mini-language: inline tags that shape how a script is read.
//
//	v1 keys:
//	  {pause:N}     — N seconds (decimal), silence before the NEXT piece
//	  {voice:name}  — sticky voice (phase 2: parsed, reported, stripped)
//
// Rules (see .scratch/directives-phases.md):
//  - every directive ENDS the current piece; mid-sentence directives are hard
//    boundaries by design
//  - adjacent pauses do not stack: the last one on a boundary wins
//  - the engine never sees this syntax: directives are parsed first and
//    stripped here; any brace-shaped text that does not parse as a known
//    directive is removed and reported, because braces are not speech
//  - a leading {pause} starts the render with silence; a trailing {pause}
//    extends the final beat; a trailing voice/direction is discarded

import type { SpeechPiece } from "./breezeClient.ts";

export const PAUSE_MIN_S = 0;
export const PAUSE_MAX_S = 15;

export interface CompiledSegment {
	/** raw text of the segment — cleaning happens per segment afterward */
	text: string;
	/** directive pause on this boundary, ms; undefined = standard beat */
	pauseBeforeMs?: number;
	/** sticky voice carried from a {voice:...} directive (carry mode only) */
	voiceId?: string;
}

export interface DirectiveReport {
	pausesApplied: number;
	pauseSecondsTotal: number;
	/** directives parsed but not wired yet (phase 2), as "key: value" */
	ignoredWiring: string[];
	removedBraces: number;
	strayBraceCount: number;
	/** voice changes carried onto segments (carry mode) */
	voiceChanges: number;
	trailingPauseMs?: number;
	warnings: string[];
}

export function summarizeDirectiveReport(
	report: DirectiveReport,
	opts?: { singleVoice?: boolean },
): string | undefined {
	const parts: string[] = [];
	if (report.pausesApplied > 0) {
		parts.push(
			`${report.pausesApplied} pause directive${report.pausesApplied === 1 ? "" : "s"} (${report.pauseSecondsTotal.toFixed(1)}s total)`,
		);
	}
	if (report.ignoredWiring.length > 0) {
		const shown = report.ignoredWiring
			.slice(0, 4)
			.map((d) => `{${d}}`)
			.join(", ");
		parts.push(
			opts?.singleVoice
				? `voice directives were parsed but speak is single-voice — move {voice:...} scripts to speakScript: ${shown}`
				: `voice directives parsed but not wired yet: ${shown}${
						report.ignoredWiring.length > 4 ? "…" : ""
					}`,
		);
	}
	if (report.voiceChanges > 0) {
		parts.push(`${report.voiceChanges} voice change(s) carried`);
	}
	if (report.removedBraces > 0) {
		parts.push(
			`${report.removedBraces} brace group(s) removed (braces are not speech)`,
		);
	}
	if (report.strayBraceCount > 0) {
		parts.push(`${report.strayBraceCount} stray brace(s) stripped`);
	}
	if (report.warnings.length > 0) {
		parts.push(...report.warnings);
	}
	if (parts.length === 0) return undefined;
	return `Directives: ${parts.join("; ")}.`;
}

export function parseDirectives(
	raw: string,
	opts?: { voiceMode?: "ignore" | "carry" },
): {
	segments: CompiledSegment[];
	trailingPauseMs?: number;
	report: DirectiveReport;
} {
	const voiceMode = opts?.voiceMode ?? "ignore";
	const report: DirectiveReport = {
		pausesApplied: 0,
		pauseSecondsTotal: 0,
		ignoredWiring: [],
		removedBraces: 0,
		strayBraceCount: 0,
		voiceChanges: 0,
		warnings: [],
	};

	const groupRe = /\{([^{}]*)\}/g;
	const segments: CompiledSegment[] = [];
	let currentText = "";
	let pendingPauseMs: number | undefined;
	let currentVoice: string | undefined;
	let sawAnyDirective = false;

	const flushCurrent = (): void => {
		const text = currentText;
		currentText = "";
		if (!/\S/.test(text)) return; // no empty pieces; state carries over
		segments.push({
			text,
			...(pendingPauseMs !== undefined ? { pauseBeforeMs: pendingPauseMs } : {}),
			...(currentVoice !== undefined ? { voiceId: currentVoice } : {}),
		});
		if (pendingPauseMs !== undefined) {
			report.pausesApplied += 1;
			report.pauseSecondsTotal += pendingPauseMs / 1000;
			pendingPauseMs = undefined;
		}
	};

	let cursor = 0;
	for (const match of raw.matchAll(groupRe)) {
		const start = match.index ?? 0;
		currentText += raw.slice(cursor, start);
		cursor = start + match[0].length;

		const inner = match[1];
		const splitAt = inner.indexOf(":");
		const key = (splitAt === -1 ? "" : inner.slice(0, splitAt)).trim().toLowerCase();
		const value = (splitAt === -1 ? "" : inner.slice(splitAt + 1)).trim();
		sawAnyDirective = true;

	if (key === "pause") {
		// a pause closes the piece before it: text | {pause} | text
		flushCurrent();
		const seconds = Number.parseFloat(value);
			if (!Number.isFinite(seconds)) {
				report.removedBraces += 1;
				report.warnings.push(`pause directive with non-numeric value ("${value}") removed`);
				continue;
			}
			const clamped = Math.min(
				PAUSE_MAX_S,
				Math.max(PAUSE_MIN_S, seconds),
			);
			if (clamped !== seconds) {
				report.warnings.push(
					`pause ${value}s clamped to ${(clamped).toFixed(1)}s`,
				);
			}
			// last one on a boundary wins; the pending pause carries across
			// empty boundaries (adjacent directives) until the next text
			pendingPauseMs = Math.round(clamped * 1000);
		} else if (key === "voice") {
			flushCurrent();
			if (voiceMode === "carry") {
				// sticky: applies from the next piece until the next {voice}
				currentVoice = value;
				report.voiceChanges += 1;
			} else {
				report.ignoredWiring.push(`voice: ${value}`);
			}
		} else {
			report.removedBraces += 1;
			report.warnings.push(`unknown directive "${key}" removed`);
		}
	}
	currentText += raw.slice(cursor);

	// trailing: a pending pause on empty tail extends the final beat (additive
	// with the standard beat per the spec); a trailing voice/direction dies with
	// the text it would have applied to
	let trailingPauseMs: number | undefined;
	if (/\S/.test(currentText)) {
		flushCurrent();
	} else if (pendingPauseMs !== undefined) {
		trailingPauseMs = pendingPauseMs;
		pendingPauseMs = undefined;
	}

	// any brace that did NOT parse as a balanced group is not speech
	let stray = 0;
	for (const segment of segments) {
		const leftover = segment.text.match(/[{}]/g);
		if (leftover) {
			stray += leftover.length;
			segment.text = segment.text.replace(/[{}]/g, " ");
		}
	}
	report.strayBraceCount = stray;
	if (!sawAnyDirective && stray === 0) {
		// fast path: nothing directive-like anywhere
		report.warnings = [];
	}

	return { segments, trailingPauseMs, report };
}

/** Test-only peek: compile a script straight to speech pieces. */
export function compileDirectivesForTest(raw: string): SpeechPiece[] {
	const { segments } = parseDirectives(raw);
	return segments.map((segment) => ({
		text: segment.text,
		...(segment.pauseBeforeMs !== undefined
			? { pauseBeforeMs: segment.pauseBeforeMs }
			: {}),
	}));
}