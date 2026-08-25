# BENCH — 대외 공개용 (bench-public)

3D 프린팅 도구 모음의 **공개 배포본**입니다. 저장된 프린터 프로필이 없고, 사용자가 자기 프린터의 출력 가능 크기(X/Y/Z)를 직접 입력합니다. 인터페이스 언어는 KO · EN · 日本語 · 中文 중에서 선택하며, 선택은 브라우저에 저장됩니다.

```
index.html      대시보드 (단일 파일, 오프라인 동작)
tools/          도구별 폴더 — 원본 저장소에서 복사해 넣으세요
```

## GitHub Pages로 올리기

1. GitHub에서 새 저장소 `bench-public`을 만듭니다 (Public).
2. 이 폴더의 `index.html`을 저장소 루트에 올립니다.
3. 원본 저장소(`3D-website`)의 `tools/` 폴더를 그대로 복사해 같은 루트에 넣습니다.
4. Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `(root)` → Save.
5. 몇 분 뒤 `https://<계정>.github.io/bench-public/` 에서 열립니다.

## 언어 추가하기

`index.html` 안의 문자열은 모두 `['한국어', 'English', '日本語', '中文']` 순서의 배열입니다. 언어를 늘릴 때는 `LANGS` / `LANG_LABELS`에 코드와 라벨을 추가하고, 각 배열 끝에 번역을 하나씩 붙이면 됩니다.

## 도구 링크 주소 바꾸기

```js
const SITE = 'https://yeseul100512.github.io/3D-website/';   // → './'
```
