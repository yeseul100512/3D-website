# BENCH: 브라우저에서 쓰는 3D 프린팅 도구

https://yeseul100512.github.io/3D-website/

STL·3MF 검사, 큰 모델 분할, 출력 무게·비용 계산, G-code 분석, 채움 설정 추천을 브라우저 안에서만 처리하는 정적 사이트입니다. 서버 업로드, 가입, 분석 스크립트가 없습니다. 한국어(`/`), 영어(`/en/`), 일본어(`/ja/`), 중국어 간체(`/zh/`) 네 가지 언어로 같은 페이지를 만듭니다.

## 도구

| 주소 | 도구 | 하는 일 |
| --- | --- | --- |
| `tools/stl-inspector/` | STL/3MF 검사·수리 | STL·3MF·OBJ의 크기, 부피, 열린 모서리·비다양체·뒤집힌 면·중복 면을 찾아 3D로 표시. 베드 적합 확인, 단위 변환, 얇은 벽 추정, 선택한 항목만 수리, STL·3MF·OBJ 저장, 여러 파일 표를 CSV·xlsx로 저장 |
| `tools/stl-cutter/` | STL 분할기 | 출력 크기에 맞게 격자로 자르고 핑거 조인트 또는 평면 절단. 조각별 실제 크기와 적합 여부, 조립 지도(SVG), 조각별 STL과 ZIP 저장 |
| `tools/print-cost-calculator/` | 출력 무게·비용 계산기 | G-code·`.gcode.3mf`의 무게와 시간(또는 모델 부피로 추정한 무게)으로 재료비, 전기요금, 장비 비용, 실패 여유분, 인건비, 판매가 계산. CSV·xlsx 저장 |
| `tools/gcode-analyzer/` | G-code 분석기 | Bambu Studio·OrcaSlicer·PrusaSlicer·Cura G-code와 `.gcode.3mf`의 출력 시간, 필라멘트 사용량, 기능별 내역. E 이동 합산으로 헤더 값 검증, 여러 플레이트 합계, 비용 계산기로 넘기기 |
| `tools/infill-recommender/` | 채움(인필) 설정 추천 | 용도·하중·재료·우선순위를 고르면 Bambu Studio 기준 채움 패턴, 밀도, 벽 수, 윗면·아랫면 층수를 이유와 함께 추천 |

3D 미리보기와 분할에만 외부 라이브러리를 씁니다(`three@0.182.0`, `three-bvh-csg@0.0.18`, 처음 쓸 때 jsDelivr에서 불러옴). 나머지는 모두 저장소 안의 코드입니다.

## 폴더 구조

```
src/        원본. 여기만 고칩니다 (자세한 규칙은 src/README.md)
tests/      단위 테스트(*.test.mjs)와 빌드된 페이지 전체 검사(site.mjs)
index.html, 404.html, sitemap.xml, robots.txt,
assets/, tools/, en/, ja/, zh/      빌드 결과물. 직접 고치지 않습니다
google1557a4d074f70f29.html         Search Console 소유 확인 파일
```

GitHub Pages가 저장소 루트를 그대로 배포하므로 빌드 결과물도 함께 커밋합니다.

## 빌드와 테스트

Python 3.9 이상과 Node 22 이상만 있으면 됩니다. 설치할 패키지는 없습니다.

```
python src/build.py                              # 사이트 전체를 다시 만듭니다
node --test tests/                               # 단위 테스트 + 빌드된 24개 페이지 검사 (빌드 후 실행)
python -m http.server 8765 --bind 127.0.0.1      # http://127.0.0.1:8765/ 에서 확인
```

번역이 한 언어라도 빠졌거나 페이지에 제목·설명이 없으면 빌드가 실패하고 어디가 문제인지 알려 줍니다. 도구를 추가하거나 고치는 방법은 `src/README.md`에 있습니다.

## 출시 전 남은 일

- [ ] **분할기 조각의 메시 품질**: 잘린 조각은 부피는 맞지만(원본 대비 0.2% 이내) 조각마다 열린 모서리가 수천 개 남습니다(받침대 4조각 기준 조각당 약 2,900~4,500개, 대부분 한쪽만 쪼개진 T자 이음). `three-bvh-csg`의 한계라서 페이지의 "한계" 항목에 적어 두었습니다. 닫힌 메시를 보장하려면 `manifold-3d`(WASM)로 바꾸는 작업이 필요합니다
- [ ] 분할한 조각을 실제 슬라이서(Bambu Studio, OrcaSlicer, PrusaSlicer, Cura)에 넣어 경고 없이 슬라이스되는지 확인하고, 실제로 출력해 조립 여유 0.3 mm 기본값 확인
- [ ] 실제 휴대폰(iOS Safari, Android Chrome)에서 확인. 지금까지는 데스크톱 Chrome의 375px 화면으로만 확인했습니다(터치로 3D 돌리기, 실제 끌어다 놓기는 확인하지 못했습니다)
- [ ] Firefox, Safari에서 확인 (모듈 Worker와 `DecompressionStream`이 필요해 Safari 16.4, Firefox 113보다 오래된 브라우저에서는 3MF를 열 수 없습니다)
- [ ] 일본어·중국어 문구를 원어민이 한 번 읽어 보기 (자동 검사는 다른 언어 글자가 섞였는지만 확인합니다)
- [ ] 다중 플레이트 3MF는 검사 도구에서 모든 플레이트를 합친 크기로 표시됩니다. 플레이트·객체별 표시가 필요한지 결정
- [ ] Lighthouse 성능 점수 측정 (접근성·SEO·권장사항은 100점, 성능은 아직 재지 않았습니다)
- [ ] 없어진 예전 주소 처리: `tools/gcode-merger/`, `tools/stl-scaler/`, `tools/stl-size-checker/`, `tools/pla-weight-calculator/`는 이제 404입니다. 검색 결과에서 빠질 때까지 둘지, 새 도구로 안내하는 페이지를 둘지 정해야 합니다
- [ ] 공유 미리보기 이미지(`og:image`) 추가
- [ ] `static-rebuild` 브랜치를 배포 브랜치에 합친 뒤 Search Console에 `sitemap.xml` 다시 제출
- [ ] 라이선스 파일 추가
