import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
const AGENTS = path.resolve('agents');

// Smoke: just round-trip every migrated YAML through js-yaml. The
// real loader (src/agent-config.ts) requires a bot token in env to
// fully load — this test isolates the parser path which is what the
// new fields actually exercise. Loader tolerates extra keys by
// design (see lines 97-108 of src/agent-config.ts).
let failed = 0;
for (const sub of fs.readdirSync(AGENTS)) {
  for (const fname of ['agent.yaml','agent.yaml.example']) {
    const f = path.join(AGENTS, sub, fname);
    if (!fs.existsSync(f)) continue;
    try {
      const parsed = yaml.load(fs.readFileSync(f,'utf-8')) as any;
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      // Confirm every new key is present in the parsed result.
      const required = ['four_rs','owns','lob','projects','ideal','platform','skills','avatar'];
      const missing = required.filter(k => !(k in parsed));
      if (missing.length) {
        console.log(`FAIL  ${path.relative(AGENTS,f)}: missing ${missing.join(',')}`);
        failed += 1;
      } else {
        console.log(`ok    ${path.relative(AGENTS,f)} (parses + has all Slice-1 keys)`);
      }
    } catch (err) {
      console.log(`FAIL  ${path.relative(AGENTS,f)}: ${(err as Error).message}`);
      failed += 1;
    }
  }
}
process.exit(failed > 0 ? 1 : 0);
