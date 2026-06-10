# Nano Banana Redo

A zero-backend web app for generating **Abigail Chase** fan art with Google's Gemini
image models (the "Nano Banana" family), modeled after the Google AI Studio UI.

Its core feature is an **auto-retry engine**: when a generation fails (safety/moderation
block, empty response, transient API error), it automatically re-runs until the target
number of images is collected — no human intervention needed.

## Quick start — no install needed

Download [`nano-banana.html`](./nano-banana.html) (one self-contained file, all JS/CSS
inlined) and double-click it to open in your browser. That's it — no npm, no server.

Paste your [Google AI Studio API key](https://aistudio.google.com/apikey) into the
**API key** field in the right-hand settings panel, enter your prompt, and hit **Run**.

Alternatively, host it on GitHub Pages: the included workflow
(`.github/workflows/deploy.yml`) builds and deploys on every push to `main` — just set
**Settings → Pages → Source** to "GitHub Actions" once (public repo, or private with a
paid plan).

## Quick start — with npm

```bash
npm install
npm run dev
```

> The API key is stored in your browser's localStorage and sent directly from the browser
> to the Gemini API. This is fine for personal/local use — never deploy this app publicly
> with your key baked in.

## Features

- **Models**: Nano Banana 2 (`gemini-3.1-flash-image`), Nano Banana Pro
  (`gemini-3-pro-image-preview`), Nano Banana (`gemini-2.5-flash-image`)
- **System instructions**: optional AI Studio-style instruction box below the model
  selector, sent as `systemInstruction` with every attempt (auto-falls back to prepending
  it to the prompt if a model rejects the field)
- **Aspect ratio**: Auto (model decides / follows reference) or explicit — 1:1, 2:3, 3:2,
  3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 (+ 1:4, 4:1, 1:8, 8:1 on Gemini 3.x)
- **Image size**: 1K / 2K / 4K (Gemini 3.x models; hidden for 2.5)
- **Output format**: PNG (as returned by the API) or JPG (converted client-side via canvas)
- **Reference images**: optional, up to 6 — drag & drop onto the prompt area or click "+";
  sent as inline image parts before the text prompt for character consistency
- **Target count + attempts cap**: pick how many images you want (1–12); the engine keeps
  rerunning failed attempts until it collects that many or hits the configurable max-attempts
  safety cap (so a permanently blocked prompt can't burn quota forever)
- **Dual-lane parallel generation**: add an optional second API key and two requests run
  concurrently, sharing the same target count and attempts cap. Each lane backs off
  independently on rate limits, and if one key dies (invalid/blocked) the other lane keeps
  going. Note: Gemini rate limits are per Google Cloud *project*, so the two keys must come
  from different projects to actually double throughput
- **Gallery**: lightbox view, per-image download, download-all as zip
- Settings, prompt, and API key persist across reloads (localStorage)

## Retry behavior

| Outcome | Counts against the attempts cap | Action |
|---|---|---|
| Image(s) returned | yes | collect, continue until target |
| Safety/moderation block (`PROHIBITED_CONTENT`, `IMAGE_SAFETY`, …) | yes | retry immediately |
| Response with no image (text refusal) | yes | retry immediately |
| 429 rate limit | no | wait (honors server `retryDelay`, else exponential backoff), retry |
| 5xx / network error | no | exponential backoff, retry (gives up after 6 consecutive) |
| 400/401/403/404 (bad key, no model access) | — | abort with a clear message |

The **Stop** button aborts instantly, including mid-request and mid-backoff; collected
images are kept.

## Mock mode (no quota needed)

Append `?mock=1` to the URL to swap the API for a scripted fake that cycles through
success → moderation block → 429 with retryDelay → safety block → empty response → success,
so you can watch the retry engine work without spending API quota.

## Scripts

```bash
npm run dev           # dev server
npm run build         # type-check + production build (dist/)
npm run build:single  # rebuild the self-contained nano-banana.html
npm run lint          # eslint
npm run preview       # serve the production build
```
