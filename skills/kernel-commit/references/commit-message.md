# Commit Message Format

The message explains the committed change to a reader who has not seen the conversation. Kernel receipts retain execution details separately.

## Write from the Diff

1. Inspect the selected/staged diff and identify the problem and resulting behavior. Use implementation artifacts as supporting context; check them against the code.
2. Write a subject and body proportional to the change. Include why the change matters, its main behaviors, relevant verification, and material limitations.
3. If the final Run only describes verification, admission, installation, or commit/push, do not use its objective or ACs as the product description. Earlier implementation context and the actual diff supply that description.
4. Compare the message with the final staged scope. A file inventory or `default=passed` is not a change summary.

## Input and Generated Provenance

- Write the exact subject/body with real newlines to a UTF-8 file outside the staged source. Pass `--message-file <path>` to either CLI entrypoint. A BOM is accepted; an empty or subject-only file is rejected before registration or staging.
- `--message-file` and `--message` are mutually exclusive. Multiline `--message` remains supported by the API for callers that already pass structured arguments safely.
- With an authored body, the generator places it immediately after the subject, then appends only `Kernel-Run`, `Kernel-Evidence`, and `Kernel-Verification` when available. It omits generated objective, AC detail, and file inventories.
- Subject-only/default input keeps the legacy generated context for compatibility. The skill uses an authored body so a closeout Run cannot replace the implementation explanation.
- The subject is capped at 96 characters; the full message remains bounded at 12,000 characters. Full paths, admission details and execution metadata remain in the receipt.

Example:

```text
feat(workflow): 단계 모듈화와 작업문서별 순차 실행 도입

큰 계획의 컨텍스트 부담을 줄이고 각 단계를 독립적으로
개선할 수 있도록 프롬프트 원본과 작업 단위를 분리한다.

- plan.md를 인덱스로 줄이고 work 문서별 구현 호출
- 승인 후 문서 변경 검증과 작업 간 통합 리뷰 추가
- 운영 프롬프트를 재사용하는 단계별 평가 지원

검증: 단위·통합 테스트와 정적 검사 통과.
대상 ADE의 실제 모델·승인 UI·재개 동작은 미검증.

Kernel-Run: run-example
```

## Message-only Amendment

Use this only when the user requests changing an existing commit message. The normal utility creates new commits; it does not implement an amend mode.

- Inspect the target commit, current HEAD, index/worktree, and remote branch. Preserve unrelated changes; do not include staged content in a message correction. If HEAD is not the target, stop to choose the correct history operation.
- Write the corrected message to a file. Use `git commit --amend --only -F <file>` for the target HEAD; compare old/new tree and parent hashes before any push. A message correction must change neither.
- For a published commit, use `git push --force-with-lease=refs/heads/<branch>:<observed-old-sha> <remote> HEAD:refs/heads/<branch>`. If the remote advanced, stop and inspect; never refresh the expected hash just to override the rejection.
- Verify remote parity and report old/new commit hashes. Existing receipts remain historical records of the old commit; do not rewrite them or claim the old receipt belongs to the amended hash. Retain the amendment's actual Git outputs as its evidence.
