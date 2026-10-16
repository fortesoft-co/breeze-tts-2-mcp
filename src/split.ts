// --- sentence-boundary splitting (ported from course-repo/agents-v2 speak tools) ---

type Sentence = { text: string; paragraphStart: boolean };

const ABBREVIATIONS = new Set([
	"approx",
	"apt",
	"ca",
	"co",
	"dept",
	"dr",
	"eq",
	"est",
	"etc",
	"fig",
	"inc",
	"jr",
	"ltd",
	"max",
	"min",
	"mr",
	"mrs",
	"ms",
	"mx",
	"no",
	"prof",
	"rd",
	"sr",
	"st",
	"vl",
	"vs",
]);

const TERMINATORS = new Set([".", "!", "?", "。", "！", "？", "…"]);

// A terminator followed by whitespace is only a boundary when the word before it
// is not a dotted initialism ("e.g.") or a known abbreviation ("Dr.").
function endsWithAbbreviation(prefix: string): boolean {
	if (/(?:\p{L}+\.)+\p{L}+$/u.test(prefix)) return true;
	const word = /\p{L}+$/u.exec(prefix);
	return Boolean(word && ABBREVIATIONS.has(word[0].toLowerCase()));
}

function scanTerminators(text: string): string[] {
	const pieces: string[] = [];
	let depth = 0; // ( and [ nesting: never split inside a vocal-event tag
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
		if (depth > 0 || !TERMINATORS.has(ch)) continue;

		// consume a run of terminators and closing quotes as one boundary
		let end = i;
		while (end + 1 < text.length) {
			const next = text[end + 1];
			if (TERMINATORS.has(next) || next === '"') end++;
			else break;
		}
		const after = text[end + 1];
		if (
			(end + 1 >= text.length || /\s/.test(after)) &&
			!endsWithAbbreviation(text.slice(0, i))
		) {
			pieces.push(text.slice(start, end + 1));
			start = end + 1;
		}
		i = end;
	}
	if (start < text.length) pieces.push(text.slice(start));
	return pieces;
}

// Bullet and numbered lines always start a piece, even without sentence punctuation.
function scanSentences(paragraph: string): string[] {
	const pieces: string[] = [];
	for (const segment of paragraph.split(/\n(?=\s*(?:[-*•]|\d+[.)]))/)) {
		pieces.push(...scanTerminators(segment));
	}
	return pieces;
}

function splitIntoSentences(text: string): Sentence[] {
	const sentences: Sentence[] = [];
	const paragraphs = text.split(/\n[ \t]*\n+/);
	for (let index = 0; index < paragraphs.length; index++) {
		let first = true;
		for (const raw of scanSentences(paragraphs[index])) {
			const piece = raw.replace(/\s+/g, " ").trim();
			if (!piece) continue;
			sentences.push({ text: piece, paragraphStart: first });
			first = false;
		}
	}
	return sentences;
}

/**
 * Split text on good sentence boundaries into pieces of at most `maxChars`,
 * forcing a new piece at paragraph breaks.
 */
export function splitIntoChunks(text: string, maxChars: number): string[] {
	const chunks: string[] = [];
	for (const sentence of splitIntoSentences(text)) {
		const current = chunks[chunks.length - 1];
		const separator = sentence.paragraphStart ? "\n\n" : " ";
		if (
			current &&
			!sentence.paragraphStart &&
			current.length + separator.length + sentence.text.length <= maxChars
		) {
			chunks[chunks.length - 1] = current + separator + sentence.text;
		} else {
			chunks.push(sentence.text);
		}
	}
	return chunks;
}
