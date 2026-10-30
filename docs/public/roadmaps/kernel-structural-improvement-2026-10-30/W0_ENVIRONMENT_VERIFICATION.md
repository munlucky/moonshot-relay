# W0 Linux 검증 환경 판정 — 2026-10-30

## 범위와 판정

- **W0 기준선·대표 안전 반례 및 동일 HEAD 소스의 격리 Linux 빌드 검증: PASS.** 전체 W0~W10 통합 계획의 COMPLETE 선언은 아니다.
- 원본 Windows 공유 마운트의 Linux 환경 정합성, native Windows/macOS Host 지원·계정 설치 검증은 **W0 PASS 범위 밖의 별도 Host 검증**으로 남긴다. 해당 미확인을 마치 PASS한 것으로 기록하지 않는다.
- 작업 기준: `main / a4b05ab7dbf822193422650b4e7abd7ba684ab29`를 `git archive HEAD`로 별도 Linux overlay `/tmp/moonshot-w0-linux-5a5jSrU8`에 복사. 원본 `.git`, 계정 SQLite, 기존 `node_modules`는 이동·수정하지 않았다.

## 환경 원인 분리

| 관측 | 증거 | 해석 |
|---|---|---|
| 원본 소스 경로 | Windows `C:\` 드라이브가 `/shared`에 9p로 연결, 당시 사용률 99% | 공유 디스크의 리소스 위험. 단독 원인 확정은 아님 |
| 원본 파일 열거 | 이전 `src/contracts` `scandir` 및 `find`에 `ENOMEM`; 이후 동일 디렉터리 목록 25개는 정상 | 간헐적 파일시스템/자원 관측. 정적 코드 결함으로 승격 금지 |
| 원본 TypeScript 설치 | `typescript@7.0.2` 존재하지만 `@typescript/typescript-linux-x64` 없음; Windows package 존재 | Windows 설치 의존성을 Linux에서 공유한 플랫폼 부적합 |
| 기본 npm 설정 | `omit=dev`로 첫 isolated `npm ci`는 개발 의존성 누락 | 실행 환경 설정. lockfile 문제 아님 |
| lockfile | Linux native TypeScript 7.0.2 패키지가 이미 선언됨 | `package-lock.json` 하드코딩/폴백 수정 불필요 |
| 적절한 isolated 설치 | `npm ci --include=dev --include=optional --ignore-scripts --no-audit --no-fund` 성공 | TS 7.0.2 Linux native와 빌드 도구용 TS 6.0.2 확인 |

## 별도 Linux overlay에서 실제 명령 검증

| 명령 또는 동일한 직접 진입점 | 판정 | 주요 출력 |
|---|---|---|
| `node tools/build/typescript-cli.cjs --noEmit` | PASS | exit 0, TS 7.0.2 Linux native 사용 |
| `node tools/build/bootstrap.mjs --boundaries` | PASS | `status=passed`, modules=9, files=308, edges=840 |
| `node tools/build/bootstrap.mjs` | PASS | `mode=build`, files=308, changed=226, removed=0. 생성 파일은 isolated 사본에만 기록 |
| 위 빌드 **직후** `node tools/build/bootstrap.mjs --check` | PASS | `mode=check`, files=308, changed=0, removed=0, edges=840 |
| TS6 도구/런타임/빌드 분리 진단 | PASS | config 대상 7/615/308 파일, diagnostics 모두 0 |

`git archive`의 새 사본에는 Git에서 추적하지 않는 생성 `scripts/` 및 `dist/debug/` 파일이 없었다. 따라서 **빌드 전에 수행한** `--check`는 대량 `changed`와 `manifestChanged=true`를 반환했다. 이는 잘못된 테스트 순서의 결과였으며, 정상 빌드 후 같은 검사에서는 0건이었다. 첫 실패 결과를 삭제하거나 통과로 재해석하지 않는다.

`npm run check:boundaries`는 원본 공유 마운트에서 60/175초, 별도 Linux 사본의 최초 npm 실행에서 145초 제한을 초과했다. 그러나 격리 사본에서 단계별 TS 진단·소스 그래프·변환은 정상 완료됐고 실제 직접 진입점도 PASS였다. **npm 실행 조건별 시간 편차의 원인은 확정되지 않았다.** 이를 해결하려는 제품 코드의 새 타임아웃·무조건 폴백·추가 Gate는 도입하지 않는다.

## W0 완료 조건과 이관

- W0 필수: 현재 소스·대표 실제 파일 쓰기·내구 차단 회귀, 격리 Runtime, SQLite Online Backup 무결성, 동일 HEAD TypeScript/Build/Boundary 검증. 모두 해당 범위에서 통과.
- W1에 이관: Run 선택·복구 권위, partial workspace 관측과 `drift=detected`의 실제 인과/차단 여부 확인. Moonremote transport만의 관측 오류는 Kernel 규칙이 아니라 외부 경계로 분리.
- W8에 이관: Host별 native 설치/계정 적용·Session 수명·Project Identity 원천 정책과 공유 마운트/플랫폼별 의존성 정합성. 필수 native 검증이 나중에 요구되면 해당 Wave 최종 판정에는 포함한다.
- W3-A: 현재 대표 반례에 제품 P0 결함은 **재현되지 않았다**. 미래의 검증에서 확인될 때만 수정한다. 방어 시스템/새 DB 상태/규칙을 예방적으로 추가하지 않는다.

이 문서는 빌드·회귀 결과의 **범위별 PASS**를 의미한다. 모든 플랫폼·프로바이더나 모든 디스크 장애에 대한 무조건적인 안전 보증은 아니다.
