import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

// Pre-migration content captured by reading from main repo (which is unmodified).
const MAIN = '/Volumes/4TB-990/dev/claude-clawos/agents';
const WT = '/Volumes/4TB-990/dev/claude-clawos/.claude/worktrees/agent-aafed50c459c92e8c/agents';

const NEW_KEYS = ['four_rs','owns','lob','projects','ideal','platform','skills','avatar'];

let failures = 0;
for (const f of fs.readdirSync(WT)) {
  for (const fname of ['agent.yaml','agent.yaml.example']) {
    const wtPath = path.join(WT, f, fname);
    const mainPath = path.join(MAIN, f, fname);
    if (!fs.existsSync(wtPath) || !fs.existsSync(mainPath)) continue;
    const wtParsed = yaml.load(fs.readFileSync(wtPath, 'utf-8')) as any;
    const mainParsed = yaml.load(fs.readFileSync(mainPath, 'utf-8')) as any;
    // Strip new keys from worktree side
    const wtExisting: any = {};
    for (const k of Object.keys(wtParsed || {})) {
      if (!NEW_KEYS.includes(k)) wtExisting[k] = wtParsed[k];
    }
    const wtJSON = JSON.stringify(wtExisting);
    const mainJSON = JSON.stringify(mainParsed);
    if (wtJSON !== mainJSON) {
      console.log(`MISMATCH ${path.relative(WT, wtPath)}`);
      console.log('  WT (existing keys only): ' + wtJSON);
      console.log('  MAIN: ' + mainJSON);
      failures += 1;
    } else {
      console.log(`ok       ${path.relative(WT, wtPath)} (existing keys preserved)`);
    }
  }
}
process.exit(failures > 0 ? 1 : 0);
