# BENCH

3D 프린팅 도구들을 한 사이트에서 골라 쓸 수 있게 모아둔 페이지입니다.

## 구조

```
index.html      메인 페이지 (도구 목록)
style.css       전체 스타일
script.js       마지막 업데이트 날짜 표시용 스크립트
tools/          도구별 폴더
```

## 새 도구 추가하는 법

1. `tools/` 아래에 도구 이름으로 폴더를 만듭니다. 예: `tools/gcode-merger/`
2. 그 폴더 안에 도구 자체의 `index.html`을 넣습니다. (파이썬으로 만든 도구라면 자바스크립트로 옮기거나, Pyodide로 감싼 버전을 넣습니다.)
3. `index.html`(메인 페이지)의 `tool-grid` 안에 카드 하나를 복사해서 다음을 채웁니다.
   - `href`: 도구 폴더 경로
   - 제목, 설명, 하단 메타 정보 한 줄
   - 도구가 실제로 작동하면 `data-status="building"`을 `data-status="ready"`로 바꾸고, `style.css`에 상태 색을 하나 추가합니다.
4. 빈 카드(`+ 새 도구 추가`)는 항상 맨 뒤에 남겨두면 다음에 추가할 위치를 바로 알 수 있습니다.

## 로컬에서 확인하기

폴더 안에서 `index.html`을 브라우저로 그냥 열어도 되고, 터미널에서 아래처럼 실행해도 됩니다.

```
python -m http.server 8000
```

그 다음 `http://localhost:8000` 접속.
