# NAIce Shot Server

[NAIce Shot](https://github.com/Near7707/NAIce-Shot) 확장의 **서버 플러그인**이에요. 실리태번에 저장된 NovelAI 키로 그림을 요청하고, 생성한 그림과 이력을 사용자 데이터 폴더에 저장·삭제해요. 확장과 함께 설치해야 해요.

> 비공식 확장이에요. NovelAI(Anlatan)나 SillyTavern 팀이 만들거나 지원하는 도구가 아니에요. / Unofficial, community-made; not affiliated with NovelAI (Anlatan) or the SillyTavern team.

## 설치 (처음 한 번)

1. 실리태번 `config.yaml`에서 `enableServerPlugins` 값을 `true`로 바꿔요.
2. 실리태번 폴더 안의 `plugins` 폴더에서 터미널(명령 프롬프트)을 열고 아래 한 줄을 실행해요.
   ```
   git clone https://github.com/Near7707/NAIce-Shot-Server naice-shot-server
   ```
3. 실리태번을 완전히 재시작해요. 서버 로그에 `[NAIce Shot] server ready`가 보이면 돼요.

폴더는 반드시 `plugins/` 바로 아래(`plugins/naice-shot-server/index.mjs`)에 있어야 해요. 실리태번의 키 관리 모듈을 상대 경로로 불러오기 때문이에요.

## 업데이트

git으로 설치했다면 **실리태번을 켤 때마다 자동으로 최신 버전으로 업데이트**돼요. `config.yaml`의 `enableServerPluginsAutoUpdate: true`가 실리태번 기본값이고, git이 설치돼 있어야 해요. 자동 업데이트를 원하지 않으면 그 값을 `false`로 바꾸고, 필요할 때 이 폴더에서 `git pull`을 실행하면 돼요.

## What it does (English)

- Routes under `/api/plugins/naice-shot/`: `status`, `history`, `generate`, `delete`.
- Reads the NovelAI key through SillyTavern's own secrets module; the key never leaves the server and is not stored in records.
- PNGs go to `<user>/user/images/naice-shot/`; generation records to `<user data root>/naice-shot-records/`, outside the web-served folder. Everything is scoped to the signed-in SillyTavern user.
- `GET /status?quick=1` returns only version, feature flags and `minClient` (no NovelAI call); the extension uses it to warn about mismatched versions.

## Development

```bash
npm test
```

Node 20+. Tests use mocked NovelAI responses and a temporary user folder.

## License

GNU Affero General Public License v3.0 (see `LICENSE`).
