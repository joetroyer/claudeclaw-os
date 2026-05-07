# Slice 1 Data-Integrity Proof — Notes

The two `data-integrity-{pre,post}.txt` files are raw command output only. They must
be bit-identical (`diff` returns zero output) per the integration plan's data-integrity
contract.

## Scope of the proof

The migration in this worktree was applied only to `agents/*/agent.yaml.example`.
Production `agents/*/agent.yaml` files (gitignored, only present in the parent repo
tree at `/Volumes/4TB-990/dev/claude-clawos/agents/`) were intentionally not touched
by the worktree commits. Both pre and post snapshots are taken from the parent repo
(`/Volumes/4TB-990/dev/claude-clawos`) so the values reflect production state, which
the `.example` migration does not change.

To apply the migration to production agent.yaml files later, run:

```
tsx scripts/migrate-agent-schema.ts /Volumes/4TB-990/dev/claude-clawos/agents
```

That step is held until after review/QA approval. Re-running the data-integrity
commands afterward should still produce identical CLAUDE.md hashes, an identical
launchctl agent count, and identical row counts for `mission_tasks` / `token_usage`,
because the migration is additive on YAML only and never touches `CLAUDE.md` or the
SQLite store.

## Reproducing

Run from `/Volumes/4TB-990/dev/claude-clawos` (parent repo, where `agents/` and
`store/claudeclaw.db` live):

```
(
  echo "=== launchctl agent count ==="
  launchctl list 2>/dev/null | grep claudeclaw | wc -l
  echo "=== mission_tasks count ==="
  sqlite3 store/claudeclaw.db "SELECT count(*) FROM mission_tasks;"
  echo "=== token_usage count ==="
  sqlite3 store/claudeclaw.db "SELECT count(*) FROM token_usage;"
  echo "=== claude_md hashes ==="
  for f in agents/*/CLAUDE.md; do
    echo "$f $(shasum -a 256 "$f" | awk '{print $1}')"
  done
)
```
