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

How to speak depends on what is available in the conversation. If the breeze
voice tools (`speak`, `designVoice`, `speechJobs`, …) are registered in this
session, use those — no other setup needed. Only when the tools are absent
but this repository is checked out locally (hosts that mounted this skill
without registering the server) fall back to the CLI from the repository
root:

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

Vocal events are free-form, placed inline at their natural spot —
descriptive phrases, not a fixed vocabulary. They need `cfgScale` 2-3 to
reproduce reliably. Instructions remain the better control for whole-line
delivery; tags are for localized events. Use sparingly: one tag at the one
beat that deserves it beats three tags in a row.

Anchors **documented upstream** (model card): `(laugh)`, `(cough)`,
`(clears throat)`, `(sigh)` — and `[笑]`, `[咳嗽]`, `[清嗓子]`, `[叹气]` for
Mandarin. **Community-expanded canon** (SillyTavern roundup — audition on
this engine before trusting): laughter — `(chuckle)`, `(giggle)`; pain —
`(cry)`, `(sob)`, `(whimper)`, `(groan)`, `(moan)`; breath —
`(breathe heavily)`; throat — `(sniffle)`; mouth — `(lip smack)`,
`(click tongue)`; reflexes — `(yawn)`, `(sneeze)`, `(hiccup)`, `(burp)`,
`(gulp)`, `(gag)`; reactions — `(grunt)`, `(scoff)`, `(snort)`. Weigh that
list against our own tests: `(gasp)` performed well here; `(inhale)` and
`(exhale)` did **not**, despite being on it. **Tested beyond all
documentation** (this engine, this stack): delivery shifts — `(whispering)`,
`(angry)`, `(return to normal)` — re-steer mid-line.

The grammar is open-ended: these tiers are a guide, not a whitelist. Compose
any short lowercase parenthetical tag, and audition it once when the moment
matters.

Delivery shifts use the same grammar mid-line: `(whispering) … (return to
normal)` re-steers the voice from the tag onward, inside the same generation
— no extra pieces, no seam.

Breath padding: a vocal event at either end of a `{pause}` often reads more
naturally than bare silence — `(sigh)` lands heavy, `(gasp)` lands tense.
Guidance, not a rule.

## Pauses

Default to none — the engine's phrasing and the beat between pieces read
naturally most of the time. `{pause:N}` is for silence that carries meaning
the words don't: a dramatic beat, or a deliberate break at a paragraph or
sentence boundary.

Mid-sentence pauses are a hard cut between two takes, with no prosodic glue
across them — reach for that only at the rare moment you would actually stop
dead.

Seconds, 0–15: `{pause:0.8}` is a beat, `{pause:2}` is a paragraph-weight
silence, `{pause:4}` and up is cinematic time. If the silence feels flat
rather than dramatic, pad it with a performed breath — see the tested tags
above.

## Queuing and overlap

Multiple utterances play back in submission order with the intended silence
between clips; the speakers are locked machine-wide so two separately
registered clients take turns instead of talking over each other. Long texts
are split on sentence boundaries before generation, which keeps delivery
consistent and never runs the engine as one unbroken pass. Blocking speak
calls return at generation end (playback queues right after), and clips
estimated past the blocking audio budget (~45s of speech) auto-switch to
background jobs — poll speechJobs for those.

## Script files and retakes

Generated files land in `<workDir>/<YYYY-MM-DD>/` — speak clips as singles
plus their transcript; `speakScript` jobs get a subfolder containing the
joined performance, every piece as its own wav, a `manifest.json` (voice and
pause gap per piece) and the exact transcript the engine read. Long scripts
work better split per act or scene — each call is an independent folder you
can audition and redo. For retakes: the per-piece wavs mean one imperfect
line is a single regeneration away, and the manifest's gap values make
re-joining reproducible (pieces are light RMS level-matched at join time —
gain-only and capped, so intended dynamics like whispers keep their shape).

## Voice library

- `designVoice` — invents a voice from a description alone; pass `name` to
  keep it permanently.
- `saveVoice` — registers an existing WAV plus its exact transcript (named =
  permanent).
- `listVoices` — shows the library; every listed id is a valid `voiceId`.
- `deleteVoice` — drops a voice from server memory (the `.breeze` file is kept
  by design; delete it yourself for permanence).