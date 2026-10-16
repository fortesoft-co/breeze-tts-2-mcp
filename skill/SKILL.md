---
name: speak
description: >-
  Speak aloud through the local Breeze TTS speakers, with voice direction,
  paralinguistic vocal-event tags and a reusable voice library. Use when the
  user asks the agent to speak, wants an audible announcement, or wants a
  designed voice applied to a text. Avoid for long unreviewed narration.
---

# Speaking with Breeze TTS

This skill shares its implementation with the MCP server in this repo — one
speech core, two entry points.

## How to speak

Preferred: MCP tools, if the host registered this repo's server
(`breeze-tts-mcp`): call `speak`.

Otherwise, use the CLI from this repository root:

```
npx tsx src/cli.ts --text "Hello there." --instruction "Calm and clear."
# or after npm run build:
node dist/src/cli.js --text "..." [--instruction ...] [--voice default]
     [--cfg-scale 2] [--max-chunk-chars 200] [--pause-ms 400]
     [--seed 42] [--no-clean] [--no-play] [--background] [--jobs]
```

Check progress at any time: `node dist/src/cli.js --jobs` (or the `speechJobs` MCP tool).

## When NOT to speak

- The user did not opt in to speech. Speaking is user-directed.
- The text is long and needs review first — draft it as text instead.
- Background jobs are dropped if the host session ends before they finish; for
  critical audio, prefer a blocking call.

## Voice direction

`instruction` describes the delivery, not the content: "Speak slowly with a
restrained, serious tone.", "Warm and cheerful, like a friendly guide.",
"A colleague leaning in with good news."

`cfgScale` controls how hard the direction is followed: 1 = neutral reading,
2-3 = strong direction. Leave it at the default 2.

## Paralinguistic tags

Free-form, placed inline at their natural spot: `(sigh)`, `(laugh)`,
`(whispering)`, `(clears throat)`, `(gasp)`, `(nervous chuckle)`, and `[叹气]` /
`[笑]` for Mandarin. They are descriptive, not a fixed vocabulary — short tags
usually fire; they need `cfgScale` 2-3 to reproduce reliably. Use sparingly:
one tag at the one beat that deserves it beats three tags in a row.

Delivery shifts use the same free-form grammar mid-line: `(whispering) …
(return to normal)` re-steers the voice from the tag onward, inside the same
generation — no extra pieces, no seam.

Tested on this engine: reliable — `(sigh)`, `(gasp)`, `(laugh)`, `(cough)`,
`(clears throat)`; delivery shifts — `(whispering)`, `(angry)`,
`(return to normal)`. Plausible but NOT performed despite the name —
`(inhale)`, `(exhale)`. Breath padding: a vocal event at either end of a
`{pause}` often reads more naturally than bare silence — `(sigh)` lands
heavy, `(gasp)` lands tense. Guidance, not a rule; audition a new tag once
before counting on it.

## Queuing and overlap

Multiple utterances play back in submission order with the intended silence
between clips; the speakers are locked machine-wide so two separately
registered clients take turns instead of talking over each other. Long texts
are split on sentence boundaries before generation, which keeps delivery
consistent and never runs the engine as one unbroken pass. Blocking speak
calls return at generation end (playback queues right after), and clips
estimated past the blocking audio budget (~45s of speech) auto-switch to
background jobs — poll speechJobs for those.

## Voice library

- `designVoice` — invents a voice from a description alone; pass `name` to
  keep it permanently.
- `saveVoice` — registers an existing WAV plus its exact transcript (named =
  permanent).
- `listVoices` — shows the library; every listed id is a valid `voiceId`.
- `deleteVoice` — drops a voice from server memory (the `.breeze` file is kept
  by design; delete it yourself for permanence).