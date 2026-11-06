# Changelog

## 0.1.23 — 2026-11-06

- Delete-all removes files left by interrupted generation recovery and checks that none remain. Uncertain charges stay marked separately from file removal.
- Generation rejects empty chat keys. Old entries with an empty key remain deletable by ID.
- Saving a draft drops invalid picture details while keeping the rest of the work.

## 0.1.22 — 2026-11-06

- History by ID list: `POST /history` takes the same fields as `GET` plus `ids` (up to 5,000 picture IDs), and pages only those pictures inside the asked range. The reply adds `filtered:true` and `unfilteredCount` (the range's full count, for "delete all" questions); pending pictures are left out of a filtered page. Used by the extension's ★-only view (0.1.84). Feature flag `history-ids`.
- Delete all (P3-2): request records without a picture — sent with no known result (`submitted`) or refused by NovelAI (`rejected`) — are no longer reported as deleted pictures. They come back in `cleared`, and the unknown ones also in `unconfirmed`. Their marker stays (a delayed retry is still refused); an unknown one keeps `unconfirmed:true`, and the status check answers `{state:'discarded',unconfirmed:true}` so the extension keeps its "check" mark. Feature flag `delete-cleared`.
- Validation: 39 server Node tests (+2; each fails with its fix reverted).

## 0.1.21 — 2026-11-05

- Include recoverable pictures in history and storage totals. Deleting them removes the pending payload and any partial PNG.
- Distinguish confirmed NovelAI rejections from ambiguous failures. A delete check verifies image absence and reports the saved-work revision without deleting anything.

## 0.1.20 — 2026-11-05

- Record the request ID before sending it to NovelAI. The status endpoint can read the original result, and its recovery action retries local storage when the server already received the image.
- Return the IDs that were deleted and the IDs that still need another deletion attempt. Keep saved work when any image deletion fails.

## 0.1.19 — 2026-11-05

- A `@[name](ref:ID)` chip with a name longer than 60 letters (up to 200, the longest profile name) now counts as `@name` too when the situation text is measured, the same as UI 0.1.80. Before, such a chip was counted at its full stored length, so a text the extension allowed could be refused.
- Validation: 31 server Node tests (one more case in an existing test).

## 0.1.18 — 2026-11-05

- The 프리샷 situation text (`snapshot.freeText`) is checked on its own, before NovelAI is called: at most 4,000 characters a person sees (a `@[name](ref:ID)` chip counts as `@name`) and at most 180,000 stored. Over the limit the request is refused with a clear 400 and nothing is sent to NovelAI, instead of the text being dropped silently from the history record. The 250,000-character request limit now counts everything except that text. A non-text value is refused as well.
- Saved work (200,000 per string, 1,000,000 total) is unchanged and still fits the longest allowed situation text and request (tested, including the undo copy).
- Needs UI 0.1.77 or newer for the matching length rules; UI 0.1.77 needs this server.
- Validation: 31 server Node tests.

## 0.1.17 — 2026-11-04

- Every failure of the NovelAI account check — HTTP error, no connection, timeout, or a reply that cannot be read — answers with `code:'nai-account'` (502; 504 for a timeout), so the UI drops its old free verdict. A timeout at this step says "생성 요청은 보내지 않았어요"; the image-request timeout keeps its own note. Free check, consent and records are unchanged.
- Validation: 30 server Node tests. Cross-repository UI validation is recorded in the extension's `docs/REVIEW.md`.

## 0.1.16 — 2026-11-04

- Shared free check (same as UI v0.1.68): the subscription state (grace period, then inactive, then missing fields) comes first for every tier; a reply without a usable `tier` is "missing", never free.
- A failed NovelAI account check answers with `code:'nai-account'` (still 502, or 401), so the UI drops its old verdict and checks again. Generation, consent and records are otherwise unchanged.
- Validation: 29 server Node tests. Cross-repository UI validation is recorded in the extension's `docs/REVIEW.md`.

## 0.1.15 — 2026-11-04

- **Free check fixed (shared `costGuard`, same as UI v0.1.67):** an active Opus V4.5 within the default size, 28 steps or fewer and one image is free and sent without Anlas consent. The old `perks.unlimitedImageGeneration` is no longer read (absent from the account reply checked on 2026-11-04 and from the current schema). Grace period → "can't tell" (cautious, checked first); `active:false` → not eligible; missing or odd fields → "can't tell", never false. V5 always needs consent.
- `/status` and the generation check forward `active`, `isGracePeriod` and `usage` (`percent`, `purchasedPercent`, `isNegative`, `timeUntilNextPercent`) as they are; anything missing or of the wrong kind is `null`. Still no account data beyond these.
- Validation: 28 server Node tests (every account case, consent on and off, failed check). Cross-repository UI validation is recorded in the extension's `docs/REVIEW.md`.

## 0.1.14 — 2026-11-04

- `GET /status?shape=1` adds `subscription.shape`: the names and kinds of the fields in NovelAI's account reply (nested paths, the first item of arrays, up to 150 lines), **never their values**; names outside `[A-Za-z0-9_$-]{1,60}` show as "(이름 생략)". Without `shape=1` nothing changes. Advertised as `account-shape` (UI v0.1.66 shows it under [서버·NAI 연결 확인]).
- Generation, the free check, billing consent, history and saved work are unchanged.
- Validation: 26 server Node tests (new: names without values, only when asked). Cross-repository UI validation is recorded in the extension's `docs/REVIEW.md`.

## 0.1.13 — 2026-11-03

- `GET /history?scope=all&kind=chat` excludes the shared free-shot bucket **before** pagination, counts, chat summaries and storage totals. The response identifies `kind:'chat'`; the existing all-history query still includes every image. Advertise `history-kinds` for UI v0.1.47's four history scopes.
- Generation, billing consent, saved work, deletion markers and record formats are unchanged. Older supported clients can still use existing history queries.
- Validation: 25 server Node tests, including interleaved chat/free records, paging, counts, summaries and size. Cross-repository UI validation is recorded in the extension's `docs/REVIEW.md`.

## 0.1.12 — 2026-11-03

- **NovelAI generation errors are named only when the reply says why:** `nai-auth` (401), `nai-anlas` (an Anlas/balance note), `nai-permission` (403 with a permission note), `nai-busy` (429), `nai-down` (5xx), otherwise `nai-rejected`. A status number alone never means "not enough Anlas". NovelAI's short note is appended (one line, ≤120 characters, tokens removed). Errors carry a `code` field.
- **The consent block is separate:** generation refused because Anlas use is not allowed now answers 428 with `code:'anlas-consent'` (was 402).
- Shared core: cost wording per account (Tablet/Scroll "이 생성은 Anlas를 사용해요.", Opus V5 "무료 사용량에 따라 Anlas가 차감될 수 있어요.", unknown account "비용 조건을 확인하지 못했어요.").
- Advertise `nai-error-codes`. Validation: 24 server Node tests; extension 0.1.46 has 136 Node tests and 35 Chromium scripts passing.

## 0.1.11 — 2026-11-03

- **Deletion markers for saved work.** Deleting work (one chat, all work, or with a chat's whole history) now replaces the file with `{revision, work:null, deleted:true}` instead of removing it. GET returns no work and the marker's revision; a save prepared before the deletion (another window's first save with `expectedRevision:null`, or an older revision) gets 409 instead of recreating the work. Markers hold no prompts or descriptions.
- Delete-all counts only files that still had work. Chats that never had work are unaffected.
- Advertise `draft-tombstone`; `MIN_CLIENT_VERSION` is 0.1.44 (older extensions would hit a conflict after deleting).
- Validation: 22 server Node tests passed; extension 0.1.44 has 135 Node tests and 34 Chromium scripts passing.

## 0.1.10 — 2026-11-03

- **프리샷 history keeps its situation text.** A free-drawing request's snapshot now stores `mode:'free'` and `freeText` (up to 4000 characters), so the extension can bring the text back when restoring. Since 0.1.39 the extension sent the text but the server dropped it; older records cannot be repaired. Other snapshots never gain a `freeText`.
- **Saved work can be deleted.** `POST /draft` with `delete:true` removes one chat's work; with `delete:true, all:true` it removes every saved work of the signed-in user. `POST /delete` with `all:true` also removes that chat's work and reports `workDeleted`.
- Advertise `draft-delete` and `free-text`. Extension 0.1.42 asks for this version.
- Validation: 22 server Node tests passed; extension 0.1.42 has 134 Node tests and 34 Chromium scripts passing.

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
