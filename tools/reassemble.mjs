// Reassemble generated whole files from their byte-split parts.
// The wholes (fish.tsx, floor.tsx) are gitignored; the parts under parts/
// are the committed source of truth. Run: node tools/reassemble.mjs
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 30000;

const TARGETS = [
  { whole: 'fish.tsx', parts: ['parts/fish.part01.tsx', 'parts/fish.part02.tsx'] },
  { whole: 'floor.tsx', parts: ['parts/floor.part01.tsx', 'parts/floor.part02.tsx'] },
];

for (const t of TARGETS) {
  const chunks = [];
  for (const p of t.parts) {
    const full = join(ROOT, p);
    const size = statSync(full).size;
    if (size > LIMIT) {
      console.error(`REFUSING: part ${p} is ${size} bytes, over the ${LIMIT}-byte limit.`);
      process.exit(1);
    }
    chunks.push(readFileSync(full));
  }
  const out = Buffer.concat(chunks);
  writeFileSync(join(ROOT, t.whole), out);
  console.log(`wrote ${t.whole} (${out.length} bytes) from ${t.parts.length} parts`);
}
