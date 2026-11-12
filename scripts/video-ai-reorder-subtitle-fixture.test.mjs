import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {
  REORDER_AUDIO_FIXTURE_DURATION_MS,
  REORDER_TIMED_SUBTITLE_FIXTURE,
} from './video-ai-reorder-subtitle-fixture.ts';

async function loadProductionSubtitleParser() {
  const source = await readFile(new URL('../app/editor/EditorStudio.tsx', import.meta.url), 'utf8');
  const sourceFile = ts.createSourceFile('EditorStudio.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const required = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name
      && ['parseTimecode', 'buildSubtitleCues'].includes(statement.name.text)) {
      required.set(statement.name.text, statement.getText(sourceFile));
    }
  }
  assert.deepEqual([...required.keys()].sort(), ['buildSubtitleCues', 'parseTimecode']);
  const typescript = `${required.get('parseTimecode')}\n${required.get('buildSubtitleCues')}\nglobalThis.parseFixture = buildSubtitleCues;`;
  const javascript = ts.transpileModule(typescript, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const sandbox = {};
  vm.runInNewContext(javascript, sandbox, { filename: 'production-subtitle-parser.js' });
  return sandbox.parseFixture;
}

test('REORDER timed subtitle fixture is accepted by the production manual-subtitle parser', async () => {
  const parseFixture = await loadProductionSubtitleParser();
  const captions = parseFixture(
    REORDER_TIMED_SUBTITLE_FIXTURE,
    REORDER_AUDIO_FIXTURE_DURATION_MS,
    true,
  );
  assert.ok(captions.length >= 2);
  for (const cue of captions) {
    assert.ok(cue.startMs >= 0);
    assert.ok(cue.endMs > cue.startMs);
    assert.ok(cue.endMs <= REORDER_AUDIO_FIXTURE_DURATION_MS);
  }
  assert.ok(captions.length > 0, 'subtitleReady-equivalent prerequisite');
  assert.equal(captions[0].startMs, 0);
  assert.equal(captions.at(-1).endMs, 2_900);
});

