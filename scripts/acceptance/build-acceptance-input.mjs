import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const env = { ...process.env, NEXT_PUBLIC_MEDCLIP_ACCEPTANCE_INPUT_HYDRATION: '1' };
const outDir = resolve(root, 'out');
export const ACCEPTANCE_INPUT_BUILD_MARKER = '.medclip-acceptance-input-build-v1.json';

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run([resolve(root, 'node_modules/next/dist/bin/next'), 'build']);
run([resolve(root, 'scripts/prepare-sites.mjs')]);

const editorHtml = readFileSync(resolve(outDir, 'editor.html'));
writeFileSync(resolve(outDir, ACCEPTANCE_INPUT_BUILD_MARKER), `${JSON.stringify({
  schemaVersion: 1,
  acceptanceInputHydration: true,
  editorHtmlSha256: createHash('sha256').update(editorHtml).digest('hex'),
})}\n`, 'utf8');
