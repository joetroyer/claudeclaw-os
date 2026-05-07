# Slice 5 — Screenshot placeholders

The committed Playwright spec at `proof/slice-5/playwright/slice-5.spec.ts`
captures `screenshots/scorecard.png` and `screenshots/budget.png` when
run against a dashboard built from this worktree's code.

In the implementation worktree the live dashboard process (PID in
`store/claudeclaw.pid`) is the **main-branch** build; restarting it to
load the worktree code would interrupt the user's active session. The
spec is ready to run; add the screenshots once the worktree branch is
merged or a temporary dashboard is spun up on a non-default port for
QA purposes.

The static QA gates ran cleanly:
- `npm run typecheck` — pass
- `npm run build:web` — pass (bundles built)
- `npx vitest run src/cost.test.ts` — 9/9 pass
