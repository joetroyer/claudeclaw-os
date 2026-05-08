/**
 * Slice 8 — Playwright spec STUB
 *
 * STATUS: stub for main-thread QA. Not run automatically.
 *
 * This file exists so main-thread QA has a single home for the slice-8
 * end-to-end checks. The implementation agent did not have a live dashboard
 * to drive Playwright against; backend coverage is in
 * `src/slice-8.contract.test.ts` (16/16 passing).
 *
 * Suggested coverage when fleshed out:
 *
 *   - Scheduled page:
 *     1. Click [data-testid=new-scheduled-task-button]
 *     2. Fill prompt + select cron preset, save
 *     3. Verify the new task appears in the list with the right cron
 *     4. Negative: invalid cron should keep Save disabled
 *
 *   - Triggered page:
 *     1. Click [data-testid=new-triggered-task-button]
 *     2. Fill name/slug/secret_env + add an action, save
 *     3. Verify the new card appears
 *     4. Edit the card, change mode test->preview, save, verify
 *     5. Delete the card, confirm modal, verify removal
 *     6. Negative: duplicate slug -> 409 surfaced as inline error
 *
 *   - Auth bypass sanity:
 *     - With cf-access-jwt-assertion header: requests succeed without ?token
 *     - Without either: 401
 */

import { test, expect } from '@playwright/test';

test.skip('slice-8 e2e (STUB — main-thread QA to flesh out)', async ({ page }) => {
  expect(page).toBeTruthy();
});
