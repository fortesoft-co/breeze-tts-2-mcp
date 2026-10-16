# breeze-tts-mcp

An MCP server that gives any MCP-speaking agent the full voice toolkit of
[Breeze-TTS-2.cpp](https://github.com/HoppouAI/Breeze-TTS-2.cpp): speak aloud with
**voice direction**, **design new voices from a description**, and manage the
saved voice library.

## Prerequisites

A running `breeze-server` (default `http://127.0.0.1:1923`):

```
build/breeze-server breeze-tts-2-q8_0.gguf --host 127.0.0.1 --port 1923 --webui
```

Neither the server nor this MCP server authenticate. Keep both bound to
`127.0.0.1`.

## Setup

```
npm install
npm run build        # emits dist/src/server.js
```

Or run it straight from source with `npm run dev` (tsx).

## Registering the server

Zed — `keymap`/`settings.json` MCP entry:

```json
{
  "context_servers": {
    "breeze-tts-mcp": {
      "source": "custom",
      "command": "node",
      "args": ["/absolute/path/to/course-repo/breeze-tts-mcp/dist/src/server.js"],
      "env": { "BREEZE_TTS_URL": "http://127.0.0.1:1923" }
    }
  }
}
```

Claude Code:

```
claude mcp add breeze-tts -- node /absolute/path/to/dist/src/server.js
```

Generic (any stdio MCP client): command `node .../dist/src/server.js`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `BREEZE_TTS_URL` | `http://127.0.0.1:1923` | Breeze server base URL |
| `BREEZE_TTS_VOICE` | `default` | Fallback saved voice for speak |
| `BREEZE_TTS_WORK_DIR` | `./breeze-tts-work` | Where generated items are written, under a `YYYY-MM-DD` day folder; `speakScript` jobs get a subfolder with per-piece wavs, `manifest.json` and the transcript |
| `BREEZE_TTS_PLAYER` | probe: ffplay, mpv, paplay, aplay | Audio player for playback. `/bin/true` disables sound |
| `BREEZE_TTS_PLAYBACK_LOCK` | tmpdir socket | Path of the machine-wide playback lock
| `BREEZE_TTS_BOOTSTRAP_VOICE` | none | WAV to seed the default voice at boot when the library lacks it (pair with the transcript row below) |
| `BREEZE_TTS_BOOTSTRAP_REF_TEXT` | none | Exact transcript of the bootstrap WAV — required with `BREEZE_TTS_BOOTSTRAP_VOICE` |

### First-run default voice

At startup the server waits for the Breeze engine (it refuses connections while the model loads) and checks whether the default voice (`BREEZE_TTS_VOICE`, "default") exists in the library. If not, it registers the bootstrapped WAV — or, without one, designs a generic warm female public-radio voice from a description and saves it under the default name. Best-effort and never blocks the server from coming up; if the engine never appears, speak still says so and `designVoice`/`saveVoice` can create the voice later.

## Tools

| Tool | Purpose |
| --- | --- |
| `speak` | Speak text aloud with voice direction. Markdown/URLs/emoji/code stripped; sentence-boundary chunking; silence between pieces; vocal-event tags like `(sigh)` supported (need cfgScale 2-3). Blocking calls hold the agent only until generation ends; clips estimated past the blocking audio budget (~45s of speech) auto-switch to background. `background: true` submits without waiting: the clip generates and plays in order after everything queued. Multi-voice scripts: `speakScript` |
| `speakScript` | Perform a multi-voice script as one artifact: dialogue and narration with a cast of voices. Cast resolves against the library first; missing members are designed on the fly and cached for the session. `{voice:name}` marks voices, `{pause:N}` exact silence, vocal/delivery tags inline. One call, one WAV, fail-fast line attribution |
| `speechJobs` | State of recent speech jobs (queued/generating/playing/done/error) with their saved WAV paths |
| `designVoice` | Invent a voice from a description alone, optionally save it permanently |
| `saveVoice` | Register an existing WAV + its exact transcript as a voice (named = permanent) |
| `listVoices` | List saved and session-cached voices |
| `deleteVoice` | Drop a voice from server memory (the `.breeze` file is kept by design) |

## Speaking from a shell / skills

`breeze-speak` (bin) is the same speech core as the MCP tools, for callers
without an MCP host:

```
npx tsx src/cli.ts --text "Hi." --instruction "Calm and clear."
node dist/src/cli.js --jobs
```

The `skill/` folder is an [Agent Skills](https://agentskills.io)-style bundle
(`speak`) that documents when and how to use the voices — symlink it so it
stays a single source of truth with the implementation:

```
ln -sfn /absolute/path/to/course-repo/breeze-tts-mcp/skill ~/.agents/skills/speak
ln -sfn /absolute/path/to/course-repo/breeze-tts-mcp/skill ~/.claude/skills/speak
```

## How playback is coordinated

Generation is serialized inside the server process (Breeze serves one request
at a time), and playback entries chain through a FIFO with their trailing
silence intact, so multi-part replies play back in submission order. On top of
that, one **machine-wide playback lock** (a bound unix socket at
`BREEZE_TTS_PLAYBACK_LOCK`) makes separately registered clients — Zed and
Claude Code, say — take turns instead of talking over each other. A holder
that crashes is detected by a failed socket connect and the lock rebinds
automatically. Limitation: the speaker of a crashed holder's detached clip may
still finish aloud over the next clip.

`speak` returns the saved WAV path so callers can replay or attach the file.

## Tests

```
npx tsx test/playback-lock.test.ts   # cross-process lock: contend + crash recovery (no sound)
BREEZE_TTS_PLAYER=/bin/true npm run test:e2e
```

Spawns the server over stdio, drives it as a real MCP client, and cycles the
full voice lifecycle against the live Breeze server.