#!/usr/bin/env bash
# Slice 6 — Solo mission_tasks regression check.
# Asserts that 10 solo mission_tasks created via the existing public
# API have the same shape as before the slice, and that NONE of them
# get tagged as workflow-owned.
#
# This script does NOT spawn real agents — it only proves the
# storage/shape contract that the slice 6 changes preserve.
#
# Run from the worktree root:
#   ./proof/slice-6/solo-mission-baseline/check.sh
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
DB=$ROOT/store/claudeclaw.db
NODE=/opt/homebrew/Cellar/node@20/20.19.6/bin/node

# 1. Snapshot mission_tasks count + workflow_stages count.
COUNT_BEFORE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM mission_tasks;")
WF_BEFORE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM workflow_stages;")
echo "Pre-check: mission_tasks=$COUNT_BEFORE workflow_stages=$WF_BEFORE"

# 2. Insert 10 solo mission_tasks via direct API call. No workflow runner.
$NODE -e '
const crypto = require("crypto");
const { initDatabase, createMissionTask, isWorkflowMissionTask } = require("./dist/db.js");
initDatabase();
for (let i = 0; i < 10; i++) {
  const id = crypto.randomBytes(4).toString("hex");
  createMissionTask(id, `solo regression #${i}`, `prompt #${i}`, "main", "regression", 0);
  if (isWorkflowMissionTask(id)) {
    console.error(`FAIL: solo task ${id} flagged as workflow-owned`);
    process.exit(2);
  }
}
console.log("Inserted 10 solo tasks; none flagged as workflow-owned.");
'

# 3. Verify count delta.
COUNT_AFTER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM mission_tasks;")
WF_AFTER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM workflow_stages;")
DELTA_M=$((COUNT_AFTER - COUNT_BEFORE))
DELTA_W=$((WF_AFTER - WF_BEFORE))
echo "Post-check: mission_tasks=$COUNT_AFTER (delta=$DELTA_M) workflow_stages=$WF_AFTER (delta=$DELTA_W)"

if [ "$DELTA_M" -ne 10 ]; then
  echo "FAIL: expected mission_tasks delta of 10, got $DELTA_M"
  exit 2
fi
if [ "$DELTA_W" -ne 0 ]; then
  echo "FAIL: solo tasks should not create workflow_stages rows; saw delta of $DELTA_W"
  exit 2
fi

# 4. Confirm shape: 12 columns + idx_mission_status index unchanged.
COL_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('mission_tasks');")
if [ "$COL_COUNT" -ne 12 ]; then
  echo "FAIL: mission_tasks should have 12 columns, has $COL_COUNT"
  exit 2
fi
IDX_OK=$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_mission_status';")
if [ "$IDX_OK" != "idx_mission_status" ]; then
  echo "FAIL: idx_mission_status missing"
  exit 2
fi

echo
echo "PASS: solo mission_tasks regression check green."
