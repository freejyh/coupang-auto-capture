# 쿠팡 반품 자동확보 flat v3

이 버전은 아이폰 업로드가 폴더를 깨뜨리는 문제를 줄이기 위해 대부분 파일을 저장소 루트에 둔 버전입니다.

## GitHub에 올라가야 하는 최종 모습

```text
.github/workflows/coupang-auto.yml
index.html
result.json
_headers
scrape.mjs
build.mjs
products.json
package.json
README.md
```

## Actions 실행

```text
Actions
→ Coupang Auto Capture
→ Run workflow
```

성공하면 `result.json`의 `updatedAt`이 바뀝니다.

## Cloudflare Pages 설정

```text
Framework preset: None
Build command: npm run build
Build output directory: public
```

## 텔레그램 알림

GitHub 저장소 → Settings → Secrets and variables → Actions → New repository secret

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```
