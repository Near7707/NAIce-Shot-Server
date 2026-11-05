# NAIce Shot Server

[NAIce Shot](https://github.com/Near7707/NAIce-Shot) 확장과 함께 쓰는 **실리태번 서버 플러그인**이에요. 확장만으로는 그림을 만들 수 없어서 둘 다 설치해야 해요.

- 실리태번에 저장된 NovelAI 키로 그림을 요청해요. 키는 서버 밖으로 나가지 않아요.
- 생성한 그림, 생성 기록, 그리기창의 마지막 작업을 내 사용자 데이터 폴더에 저장하고 지워요.

> 비공식 확장이에요. NovelAI(Anlatan)나 SillyTavern 팀이 만들거나 지원하는 도구가 아니에요. / Unofficial, community-made; not affiliated with NovelAI (Anlatan) or the SillyTavern team.

## 설치 (처음 한 번)

1. 실리태번 `config.yaml`에서 `enableServerPlugins` 값을 `true`로 바꿔요.
2. 실리태번 폴더 안의 `plugins` 폴더에서 터미널(명령 프롬프트)을 열고 아래 한 줄을 실행해요.
   ```
   git clone https://github.com/Near7707/NAIce-Shot-Server naice-shot-server
   ```
3. 실리태번을 완전히 재시작해요. 서버 로그에 `[NAIce Shot] server ready`가 보이면 돼요.

폴더는 반드시 `plugins/` 바로 아래(`plugins/naice-shot-server/index.mjs`)에 있어야 해요. 실리태번의 키 관리 기능을 그 위치 기준으로 불러오기 때문이에요.

확장 설치 방법은 [NAIce Shot README](https://github.com/Near7707/NAIce-Shot)를 봐 주세요.

## 업데이트

git으로 설치했다면 **실리태번을 켤 때마다 자동으로 최신 버전으로 업데이트**돼요. 실리태번 기본값인 `config.yaml`의 `enableServerPluginsAutoUpdate: true`를 그대로 두고, 컴퓨터에 git이 설치돼 있으면 돼요. 자동 업데이트를 원하지 않으면 그 값을 `false`로 바꾸고, 필요할 때 이 폴더에서 `git pull`을 실행해요.

확장과 서버를 같이 업데이트해야 하는 버전은 확장 [CHANGELOG](https://github.com/Near7707/NAIce-Shot/blob/main/CHANGELOG.md)에 **extension + server**라고 적혀 있어요. 순서는 **서버 업데이트 → 실리태번 재시작 → 확장 업데이트 → 새로고침**이에요. 서버가 이전 버전이면 확장 패널을 열 때 안내가 떠요.

이력은 확장에서 이 채팅·모든 채팅·프리샷·전체 보기로 나눠 볼 수 있어요. UI v0.1.47의 모든 채팅 보기는 서버 v0.1.13 이상이 필요해요. UI v0.1.80은 서버 v0.1.19 이상이 필요해요(상황 글 길이를 NovelAI 호출 전에 검사하고, 긴 칩 이름도 화면 글자로 세요). 개발·리뷰 결과는 [공통 리뷰 기록](https://github.com/Near7707/NAIce-Shot/blob/main/docs/REVIEW.md)에 모아요.

## 저장하는 데이터

모두 로그인한 실리태번 사용자의 데이터 폴더 안에만 저장돼요. 다른 사용자의 그림이나 작업은 읽을 수 없어요.

| 무엇 | 위치 | 지우는 방법 |
| --- | --- | --- |
| 그림 PNG | `user/images/naice-shot/` | 확장의 이력에서 그림 삭제 |
| 생성 기록 (프롬프트·생성 설정·장면) | `naice-shot-records/` | 그림을 지우면 함께 지워져요 |
| 그리기창의 마지막 작업 (채팅마다 하나, 프리샷 하나) | `naice-shot-work/` | 확장 설정 → **저장된 작업 모두 지우기**, 또는 **이 채팅 이력 전체 삭제** |

- **NovelAI 키**는 실리태번이 보관한 것을 읽기만 하고, 기록이나 작업 파일에는 저장하지 않아요.
- **생성 기록(JSON)**은 확장의 「추출 AI 응답 원문 추가 보관」 옵션과 상관없이 저장돼요. 프롬프트·생성 설정·seed·장면·생성 일시·채팅 정보가 들어가고, 프리샷은 직접 쓴 상황 글도 저장돼요. 채팅 메시지 원문을 따로 복사해 두지는 않지만(어느 메시지인지 알아보는 짧은 지문과 작성 시각만), AI가 인용한 내용은 장면 결과에 남을 수 있어요.
- **추출 AI 응답 원문**은 그 옵션을 직접 켰을 때만 이력과 마지막 작업에 추가로 보관돼요(생각 과정은 빼고). 옵션을 꺼도 이미 보관된 원문은 지워지지 않아요.
- 이력에서 지우면 그림 파일과 기록이 함께 지워져요. 기록 없이 그림 파일만 남은 경우(기록을 쓰다 실패했거나 손으로 지운 경우)는 이력에 보이지 않으니 폴더에서 직접 지워 주세요. 실리태번에서 채팅을 지워도 그 채팅의 그림과 기록은 남아요.
- **파일 이름**(`naice-shot-<무작위 ID>.png`)에는 이름·계정·채팅 내용이 들어가지 않아요. 다만 원본 PNG 안에는 프롬프트·생성 설정이 남을 수 있어서, 다른 곳에 올릴 땐 확장에서 **공유용 PNG**로 저장하는 걸 추천해요.
- **구독 등급:** Opus가 아니어도 쓸 수 있어요. Tablet·Scroll은 그림마다 Anlas가 들어서, 확장에서 **Anlas 사용 가능성 허용**을 켜야 생성돼요. 무료 체험 계정의 외부 API 사용은 확인되지 않았어요.
- 데이터 폴더를 통째로 백업하거나 남에게 보낼 때는 위 폴더들도 함께 포함된다는 점을 기억해 주세요.

## 문제 해결

- **서버 로그에 `server ready`가 안 보여요:** `enableServerPlugins: true`인지, 폴더가 `plugins/naice-shot-server/` 바로 아래에 있는지 확인하고 실리태번을 재시작해요.
- **확장에서 "서버 플러그인을 찾지 못했어요"가 떠요:** 위와 같아요. 실리태번을 완전히 껐다 켜야 플러그인을 다시 읽어요.
- **"서버 플러그인이 이전 버전이에요"가 떠요:** 실리태번을 재시작하면 자동 업데이트돼요. 자동 업데이트를 껐다면 이 폴더에서 `git pull` 후 재시작해요.

버전별 변경 내용은 [CHANGELOG.md](CHANGELOG.md)에 있어요.

## For developers (English)

Routes live under `/api/plugins/naice-shot/` and are scoped to the authenticated SillyTavern user.

| Route | Purpose |
| --- | --- |
| `GET /status` | Version, feature flags and `minClient`. `?quick=1` skips the NovelAI subscription check. The subscription part carries tier, active, grace period, V5 usage and Anlas only (0.1.15; missing values are `null`). `?shape=1` (0.1.14) adds the account reply's field names and kinds — never values. |
| `GET /history` | Paged records for `chatKey`; `scope=all` lists every chat, with per-chat counts and total size. |
| `POST /generate` | Calls NovelAI once per `requestId` (repeat IDs return the stored record), saves the PNG and record. Refuses with 428 `anlas-consent` when the request may cost Anlas and `allowAnlas` is off. NovelAI failures carry a `code` (`nai-auth`, `nai-anlas`, `nai-permission`, `nai-busy`, `nai-down`, `nai-rejected`) and NovelAI's short note. |
| `POST /delete` | Deletes chosen images of one chat, or `all:true` for that chat (also deletes its saved work; reports `workDeleted`). |
| `GET /draft`, `POST /draft` | One saved work per `chatKey`. POST needs `expectedRevision` and returns a new revision; a stale revision gets 409 and nothing is replaced. `delete:true` deletes one work, `delete:true, all:true` all of the user's work. Deleting leaves a content-free marker with a new revision, so saves prepared before the deletion are refused. |

- Storage: PNGs in `<user>/user/images/naice-shot/`; records in `<user data root>/naice-shot-records/` and work in `<user data root>/naice-shot-work/` (SHA-256 file names), both outside the web-served folder. Saved work is replaced atomically.
- The NovelAI key is read through SillyTavern's secrets module and never written to records or responses.
- Records omit the request authorization header. Raw extraction text is kept only on explicit opt-in, with reasoning blocks removed. 프리샷 records keep their situation text (`snapshot.mode`, `snapshot.freeText`).
- `core.mjs` is shared with the extension (identical apart from the version line); the extension's test suite checks this. `draft-work.mjs` is shared too.
- Compatibility: the extension raises `MIN_SERVER_VERSION` / required features in its `compat.mjs`; this server raises `MIN_CLIENT_VERSION` in `handlers.mjs` when it needs a newer extension.

```bash
npm test
```

Node 20+. Tests use mocked NovelAI responses and a temporary user folder; no paid request is sent.

## License

GNU Affero General Public License v3.0 (see `LICENSE`).
