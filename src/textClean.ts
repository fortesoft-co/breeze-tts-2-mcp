// --- speech text cleanup (ported from course-repo/agents-v2 speak tools) ---

const NOISE_SYMBOLS_RE =
	/[\u{1F000}-\u{1FAFF}\u{2500}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2200}-\u{22FF}\u{2028}\u{2029}]/gu;

// combining-adjacent bits (variation selectors, zero-widths, bidi controls) cannot
// live in a character class alongside regular characters; strip them by codepoint
function isInvisibleCodepoint(cp: number): boolean {
	return (
		(cp >= 0xfe00 && cp <= 0xfe0f) ||
		(cp >= 0x200b && cp <= 0x200f) ||
		(cp >= 0x202a && cp <= 0x202e) ||
		cp === 0x2060
	);
}

/**
 * Strip markdown, URLs, code, emoji and other markup the TTS model cannot
 * speak sensibly. Parenthetical vocal-event tags such as (sigh) / [叹气] are
 * preserved - they are model input, not formatting.
 */
export function cleanForSpeech(input: string): string {
	let text = input.replace(/\r\n?/g, "\n");

	// fenced code blocks are not speech; drop the whole block
	text = text.replace(/```[\s\S]*?```/g, "\n\n");
	text = text.replace(/~~~[\s\S]*?~~~/g, "\n\n");
	text = text.replace(/`{3,}|~{3,}/g, "\n\n"); // unterminated fence leftovers

	// images and link URLs go; the label text stays
	text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
	text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
	text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
	text = text.replace(/\[\^[^\]]*\]/g, " "); // footnote refs
	text = text.replace(/\[\s*\d+\s*\]/g, " "); // bare citation markers
	text = text.replace(/<https?:\/\/[^>]+>/gi, " ");
	text = text.replace(/\S*https?:\/\/\S+/gi, " ");

	// HTML remnants
	text = text.replace(/<[^<>\n]{1,120}>/g, " ");
	text = text
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#0*39;|&#x0*27;/gi, "'");

	// backslash escapes, inline code ticks, emphasis, strikethrough
	text = text.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1");
	text = text.replace(/`+([^`]*)`+/g, "$1");
	text = text.replace(/(\*\*\*|___)([^*_]+)\1/g, "$2");
	text = text.replace(/(\*\*|__)([^*_]+)\1/g, "$2");
	text = text.replace(/(\*)(\S[^*]*)\1/g, "$2"); // *emphasis* works mid-word
	text = text.replace(
		/(?<![\p{L}\p{N}])_([^_\s](?:[^_]*[^_\s])?)_(?![\p{L}\p{N}])/gu,
		"$1",
	); // _emphasis_ only at word edges, so snake_case survives
	text = text.replace(/~~([^~]+)~~/g, "$1");

	// line-level markdown: headings, blockquotes, bullets, rules, tables
	text = text
		.split("\n")
		.map((line) => {
			let l = line.replace(
				/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#{0,6}[ \t]*$/,
				"$1",
			);
			l = l.replace(/^(?:[ \t]{0,3}>[ \t]?)+/, "");
			l = l.replace(/^[ \t]{0,3}[-*•][ \t]+(?=\S)/, "");
			if (/^\s*\[[^\]]+\]:/.test(l)) return ""; // reference/footnote definitions
			if (/^[ \t]*[-=|:+~*#][-=|:+~*# \t]*$/.test(l)) return ""; // rules, separators
			l = l.replace(/\|/g, " ");
			return l.replace(/[ \t]+$/, "");
		})
		.join("\n");

	// symbols that read as noise: emoji, box/shape art, arrows, math operators
	text = text.replace(NOISE_SYMBOLS_RE, " ");
	text = Array.from(text)
		.filter((ch) => !isInvisibleCodepoint(ch.codePointAt(0) ?? 0))
		.join("");
	text = text.replace(/\u{2022}/gu, ",");

	// normalize whitespace but keep paragraph and sentence structure
	text = text.replace(/[ \t]+/g, " ");
	text = text.replace(/(\n[ \t]*){2,}/g, "\n\n");
	text = text.replace(/\(\s*\)|\[\s*\]/g, " "); // empties left by removals
	return text.trim();
}
