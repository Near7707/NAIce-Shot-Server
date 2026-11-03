# Changelog

## 0.1.9 — 2026-11-03

- Add authenticated per-user **GET /draft** and **POST /draft** for the extension's last work. Each chat (and the independent free-drawing bucket) has one private hashed file under `naice-shot-work/`.
- Atomic replacements and expected-revision checks reject conflicting writers with 409. Drafts are bounded and exclude request payloads, raw source text and raw extraction responses unless explicitly opted in. Reasoning blocks are stripped from opted-in responses; one clear undo is retained.
- Advertise `draft-work`. No change to NovelAI generation payloads, image files or existing history. Existing clients remain supported.
- Validation: 20 server Node tests passed; extension 0.1.41 has 133 Node tests and 34 Chromium scripts passing. Real accounts and iPhone Safari were not tested.

## 0.1.8 — 2026-11-03

- Shared core synced with NAIce Shot 0.1.33: profiles carry a wardrobe (named outfits). The server's own routes are unchanged.

## 0.1.7 — 2026-10-24

- Moved into its own repository (previously the `server/` folder of NAIce-Shot) so it can be cloned into `plugins/` and auto-updated by SillyTavern. No code change from the 0.1.7 server plugin.

Earlier history (0.1.0 – 0.1.7, server and extension together) is in the [NAIce-Shot changelog](https://github.com/Near7707/NAIce-Shot/blob/main/CHANGELOG.md).
