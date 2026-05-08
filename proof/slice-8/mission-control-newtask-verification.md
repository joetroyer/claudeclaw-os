# Mission Control — New Task button verification

DEFERRED — main thread will verify in Chrome DevTools final QA pass.

Notes for the QA pass:
- Slice 8 did not modify Mission Control (`web/src/pages/MissionControl.tsx`) routes or
  components. The "New Task" button on Mission Control is unrelated to the new
  Scheduled / Triggered task creation flows added in this slice.
- This slice adds two new headers buttons:
  - `data-testid="new-scheduled-task-button"` on the Scheduled page
  - `data-testid="new-triggered-task-button"` on the Triggered page
  Both should be exercised end-to-end against the running dashboard.
