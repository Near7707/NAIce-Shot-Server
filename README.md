# NAIce Shot Server

**English** · [한국어](README.ko.md)

A **SillyTavern server plugin** used together with the [NAIce Shot](https://github.com/Near7707/NAIce-Shot) extension. The extension cannot make pictures on its own, so you need to install both.

- It sends picture requests with the NovelAI key saved in SillyTavern. The key never leaves the server.
- It saves and deletes generated pictures, generation records and the drawing window's last work in your own user data folder.

> Unofficial, community-made; not affiliated with NovelAI (Anlatan) or the SillyTavern team.

## Install (once)

1. In SillyTavern's `config.yaml`, set `enableServerPlugins` to `true`.
2. Open a terminal (command prompt) in the `plugins` folder inside your SillyTavern folder and run this line:
   ```
   git clone https://github.com/Near7707/NAIce-Shot-Server naice-shot-server
   ```
3. Restart SillyTavern completely. When the server log shows `[NAIce Shot] server ready`, you are done.

The folder must be directly under `plugins/` (`plugins/naice-shot-server/index.mjs`), because SillyTavern's key handling is loaded relative to that location.

For installing the extension (and the phone/Termux steps), see the [NAIce Shot README](https://github.com/Near7707/NAIce-Shot/blob/main/README.md#install).

## Updates

If you installed with git, **it updates itself to the latest version every time SillyTavern starts.** Leave SillyTavern's default `enableServerPluginsAutoUpdate: true` in `config.yaml` as it is, and have git installed on your computer. If you don't want automatic updates, set it to `false` and run `git pull` in this folder when you need to.

Versions that need the extension and the server updated together are marked **extension + server** in the extension's [CHANGELOG](https://github.com/Near7707/NAIce-Shot/blob/main/CHANGELOG.md). The order is **update the server → restart SillyTavern → update the extension → refresh**. If the server is older, the extension shows a notice when you open the panel.

The extension shows history split into This chat, All chats, Free Shot and Everything. The All chats view of UI v0.1.47 needs server v0.1.13 or later. UI v0.1.80 needs server v0.1.19 or later (it checks the situation text length before calling NovelAI and counts long chip names by their on-screen characters). Development and review notes are collected in the [shared review record](https://github.com/Near7707/NAIce-Shot/blob/main/docs/REVIEW.md).

## What is saved

Everything is saved only inside the data folder of the signed-in SillyTavern user. Other users' pictures and work cannot be read.

| What | Where | How to delete |
| --- | --- | --- |
| Picture PNGs | `user/images/naice-shot/` | Delete the picture in the extension's history |
| Generation records (prompt, generation settings, scene) | `naice-shot-records/` | Deleted together with the picture |
| The drawing window's last work (one per chat, one for Free Shot) | `naice-shot-work/` | Extension Settings → **Delete all saved work**, or **Delete all history of this chat** |

- **The NovelAI key** is only read from where SillyTavern keeps it. It is not saved in records or work files.
- **Generation records (JSON)** are saved whether or not the extension's **Also keep the Extraction AI's raw reply** option is on. They hold the prompt, generation settings, seed, scene, generation time and chat information; Free Shot records also keep the situation text you wrote. Chat messages are not copied (only a short fingerprint that identifies the message and its time), but text the AI quoted can remain in the scene result.
- **The Extraction AI's raw reply** is kept in the history and the last work only when you turn that option on yourself (without the thinking part). Turning the option off does not delete raw replies already kept.
- Deleting from the history deletes the picture file and its record together. A picture file left without a record (writing the record failed, or it was deleted by hand) does not show in the history, so delete it from the folder yourself. Deleting a chat in SillyTavern leaves that chat's pictures and records.
- **File names** (`naice-shot-<random ID>.png`) contain no names, accounts or chat content. The original PNG can still hold the prompt and generation settings, so when you post a picture elsewhere, saving it as a **Clean PNG** in the extension is recommended.
- **Subscription tier:** you don't need Opus. Tablet and Scroll use Anlas for every picture, so **Allow possible Anlas use** must be on in the extension to generate. Whether a free trial account can use the outside API has not been confirmed.
- When you back up or send your whole data folder, remember that the folders above are included.

## Troubleshooting

- **The server log doesn't show `server ready`:** check that `enableServerPlugins: true` is set and that the folder is directly under `plugins/naice-shot-server/`, then restart SillyTavern.
- **The extension says "Could not find the server plugin":** same as above. SillyTavern reads plugins again only after a full stop and start.
- **The extension says the server plugin is an older version:** restarting SillyTavern updates it automatically. If you turned automatic updates off, run `git pull` in this folder and restart.

## Uninstall

1. To remove the pictures too, first delete them in the extension's history. A picture and its generation record are deleted together.
2. Delete the NAIce Shot extension in SillyTavern's Manage extensions.
3. Stop SillyTavern and delete the whole `plugins/naice-shot-server` folder. On a phone (Termux): `rm -rf ~/SillyTavern/plugins/naice-shot-server`.
4. Start SillyTavern again.

If other server plugins need it, leave `enableServerPlugins` in `config.yaml` as it is.

These are not deleted automatically and stay in your user data folder (usually `data/default-user/`). Delete them yourself to remove everything:

- Generated pictures: `user/images/naice-shot/`
- Generation records: `naice-shot-records/`
- The drawing window's last work: `naice-shot-work/`

The extension's settings and the attachment information in chats also stay, but nothing uses them without the extension.

Changes for each version are in [CHANGELOG.md](CHANGELOG.md).

## For developers

Routes live under `/api/plugins/naice-shot/` and are scoped to the authenticated SillyTavern user.

| Route | Purpose |
| --- | --- |
| `GET /status` | Version, feature flags and `minClient`. `?quick=1` skips the NovelAI subscription check. The subscription part carries tier, active, grace period, V5 usage and Anlas only (0.1.15; missing values are `null`). `?shape=1` (0.1.14) adds the account reply's field names and kinds — never values. |
| `GET /history` | Paged records for `chatKey`; `scope=all` lists every chat, with per-chat counts and total size. |
| `POST /history` | Same as `GET` with the fields in the body, plus `ids`: only those pictures (0.1.22, the extension's favorites). Adds `filtered` and `unfilteredCount`; no pending pictures in a filtered page. |
| `POST /generate` | Calls NovelAI once per `requestId` (repeat IDs return the stored record), saves the PNG and record. Refuses with 428 `anlas-consent` when the request may cost Anlas and `allowAnlas` is off. Opus V5 within the free conditions (0.1.24): sent without `allowAnlas` while the base usage is 2 % or more; at 1 % or below, unusable or unknown usage (or a percent that is not a whole number from 0) it refuses with 400 `usage-confirm` (0.1.25; 428 in 0.1.24 — nothing sent, no request record) until the same request comes with `confirmUsage:true`. NovelAI failures carry a `code` (`nai-auth`, `nai-anlas`, `nai-permission`, `nai-busy`, `nai-down`, `nai-rejected`) and NovelAI's short note. |
| `POST /delete` | Deletes chosen images of one chat, or `all:true` for that chat (also deletes its saved work; reports `workDeleted`). With `all:true`, request records that never became a picture are reported in `cleared` (0.1.22), and those whose result was never known also in `unconfirmed` — they are not counted as deleted pictures. |
| `GET /draft`, `POST /draft` | One saved work per `chatKey`. POST needs `expectedRevision` and returns a new revision; a stale revision gets 409 and nothing is replaced. `delete:true` deletes one work, `delete:true, all:true` all of the user's work. Deleting leaves a content-free marker with a new revision, so saves prepared before the deletion are refused. |

- Storage: PNGs in `<user>/user/images/naice-shot/`; records in `<user data root>/naice-shot-records/` and work in `<user data root>/naice-shot-work/` (SHA-256 file names), both outside the web-served folder. Saved work is replaced atomically.
- The NovelAI key is read through SillyTavern's secrets module and never written to records or responses.
- Records omit the request authorization header. Raw extraction text is kept only on explicit opt-in, with reasoning blocks removed. Free Shot records keep their situation text (`snapshot.mode`, `snapshot.freeText`).
- `core.mjs` is shared with the extension (identical apart from the version line); the extension's test suite checks this. `draft-work.mjs` is shared too.
- Compatibility: the extension raises `MIN_SERVER_VERSION` / required features in its `compat.mjs`; this server raises `MIN_CLIENT_VERSION` in `handlers.mjs` when it needs a newer extension.

```bash
npm test
```

Node 20+. Tests use mocked NovelAI responses and a temporary user folder; no paid request is sent.

## License

GNU Affero General Public License v3.0 (see `LICENSE`).
