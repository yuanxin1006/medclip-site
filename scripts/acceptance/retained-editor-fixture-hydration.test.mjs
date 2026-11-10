import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ACCEPTANCE_INPUT_BUILD_MARKER,
  PROJECT_STORAGE_KEY,
  acceptanceInitScript,
  assertAcceptanceInputHydrationBuild,
  transitionAcceptanceEditorFixture,
  waitForAcceptanceInputHydration,
} from './medclip-browser-harness.mjs';
import {
  createExecutionEditorFixtureV1,
  createImmutableRepetitionEditorFixtureV1,
} from './editor-input-fixtures.mjs';
import { prepareRetainedExecutionFixture } from './retained-execution-browser-handlers.mjs';

async function withAcceptanceBuild(run) {
  const root = await mkdtemp(join(tmpdir(), 'medclip-hydration-'));
  try {
    const editorHtml = Buffer.from('<!doctype html><title>acceptance</title>');
    await writeFile(join(root, 'editor.html'), editorHtml);
    await writeFile(join(root, ACCEPTANCE_INPUT_BUILD_MARKER), JSON.stringify({
      schemaVersion: 1,
      acceptanceInputHydration: true,
      editorHtmlSha256: createHash('sha256').update(editorHtml).digest('hex'),
    }));
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createTransitionHarness(outDir, { staleFixtureId = 'campus-preview-v1' } = {}) {
  const storage = new Map([[PROJECT_STORAGE_KEY, JSON.stringify({ id: 'campus-project' })]]);
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  const scripts = [{ script: acceptanceInitScript, arg: undefined }];
  let currentUrl = 'http://acceptance.test/editor';
  let currentWindow = {
    __MEDCLIP_ACCEPTANCE_DOCUMENT_ID__: 'campus-document',
    __MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__: [{
      sequence: 1,
      diagnostic: {
        schemaVersion: 1, kind: 'ACCEPTANCE_INPUT_HYDRATED', stage: 'ACCEPTANCE_INPUT_HYDRATION',
        fixtureId: staleFixtureId, fixtureVersion: 1, semanticAssetCount: 2,
        rhythmEvidencePresent: false, category: 'SUCCESS',
      },
    }],
    localStorage,
  };
  let documentCounter = 0;

  async function inWindow(fn, arg) {
    const priorWindow = globalThis.window;
    try {
      globalThis.window = currentWindow;
      return await fn(arg);
    } finally {
      if (priorWindow === undefined) delete globalThis.window;
      else globalThis.window = priorWindow;
    }
  }

  const page = {
    async evaluate(fn, arg) { return inWindow(fn, arg); },
    async waitForFunction(fn, arg) {
      if (!await inWindow(fn, arg)) throw new Error('synthetic hydration timeout');
    },
    async goto(url) {
      currentUrl = url;
      const listeners = new Map();
      const parsed = new URL(url);
      currentWindow = {
        location: { search: parsed.search },
        localStorage,
        addEventListener(type, listener) { listeners.set(type, listener); },
      };
      documentCounter += 1;
      for (const entry of scripts) await inWindow(entry.script, entry.arg);
      assert.ok(currentWindow.__MEDCLIP_ACCEPTANCE_INPUT_EVIDENCE__, 'fixture init did not supply input evidence');
      const semanticAssetCount = currentWindow.__MEDCLIP_ACCEPTANCE_INPUT_EVIDENCE__.semanticEvidence.length;
      const diagnosticListener = listeners.get('medclip:acceptance-diagnostic');
      await inWindow(diagnosticListener, { detail: {
        schemaVersion: 1,
        kind: 'ACCEPTANCE_INPUT_HYDRATED',
        stage: 'ACCEPTANCE_INPUT_HYDRATION',
        fixtureVersion: currentWindow.__MEDCLIP_ACCEPTANCE_INPUT_EVIDENCE__.version,
        semanticAssetCount,
        rhythmEvidencePresent: currentWindow.__MEDCLIP_ACCEPTANCE_INPUT_EVIDENCE__.rhythmEvidence !== undefined,
        category: 'SUCCESS',
      } });
      return { documentCounter };
    },
    url() { return currentUrl; },
    locator() { return { async count() { return 0; } }; },
  };
  const harness = {
    outDir,
    server: { url: 'http://acceptance.test' },
    context: { async addInitScript(script, arg) { scripts.push({ script, arg }); } },
    page,
  };
  return {
    harness,
    project: () => JSON.parse(storage.get(PROJECT_STORAGE_KEY)),
    diagnosticBuffer: () => currentWindow.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__ ?? [],
    documentId: () => currentWindow.__MEDCLIP_ACCEPTANCE_DOCUMENT_ID__,
  };
}

test('acceptance input build attestation rejects missing and stale normal-build roots', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'medclip-normal-build-'));
  try {
    await assert.rejects(assertAcceptanceInputHydrationBuild(empty), /run npm run build:acceptance-input/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
  await withAcceptanceBuild(async root => {
    await writeFile(join(root, 'editor.html'), '<!doctype html><title>changed</title>');
    await assert.rejects(assertAcceptanceInputHydrationBuild(root), /attestation is missing, invalid, or stale/);
  });
});

test('direct execution resume hydrates through the shared context hook and consumes a new document event', async () => {
  await withAcceptanceBuild(async root => {
    const fixture = createExecutionEditorFixtureV1();
    const state = createTransitionHarness(root);
    const result = await transitionAcceptanceEditorFixture({
      harness: state.harness,
      editorInputFixture: fixture,
    });
    assert.equal(result.fixtureId, 'medical-review-execution-v1');
    assert.equal(result.baseline.documentId, 'campus-document');
    assert.notEqual(state.documentId(), result.baseline.documentId);
    assert.equal(result.diagnostic.fixtureId, fixture.fixtureId);
    assert.deepEqual(state.project(), fixture.initialProject);
  });
});

test('retained execution preparation coordinates hydration and verifies the authoritative project', async () => {
  await withAcceptanceBuild(async root => {
    const fixture = createExecutionEditorFixtureV1();
    const state = createTransitionHarness(root);
    const result = await prepareRetainedExecutionFixture({
      harness: state.harness,
      gateFixtures: { fixtureIdentity: 'EXECUTION', editorInputFixture: fixture },
    });
    assert.equal(result.fixtureId, fixture.fixtureId);
    assert.equal(result.semanticAssetCount, fixture.fixtureAssertions.semanticAssetCount);
    assert.equal(result.rhythmEvidencePresent, true);
    assert.equal(result.proposalPresent, false);
  });
});

test('campus to execution to repair transitions are deterministic and do not leak the prior fixture', async () => {
  await withAcceptanceBuild(async root => {
    const execution = createExecutionEditorFixtureV1();
    const repair = createImmutableRepetitionEditorFixtureV1();
    const state = createTransitionHarness(root);
    assert.equal(state.project().id, 'campus-project');
    await transitionAcceptanceEditorFixture({ harness: state.harness, editorInputFixture: execution });
    assert.deepEqual(state.project(), execution.initialProject);
    await transitionAcceptanceEditorFixture({ harness: state.harness, editorInputFixture: repair });
    assert.deepEqual(state.project(), repair.initialProject);
    assert.equal(state.diagnosticBuffer().at(-1).diagnostic.fixtureId, repair.fixtureId);
  });
});

test('stale hydration evidence and a new wrong fixture identity fail closed', async () => {
  await withAcceptanceBuild(async root => {
    const execution = createExecutionEditorFixtureV1();
    const state = createTransitionHarness(root, { staleFixtureId: execution.fixtureId });
    const baseline = {
      documentId: state.documentId(),
      sequence: state.diagnosticBuffer().at(-1).sequence,
    };
    await assert.rejects(
      waitForAcceptanceInputHydration(state.harness.page, execution, baseline),
      /synthetic hydration timeout/,
    );

    const repair = createImmutableRepetitionEditorFixtureV1();
    await transitionAcceptanceEditorFixture({ harness: state.harness, editorInputFixture: repair });
    const newBaseline = { documentId: 'different-prior-document', sequence: 0 };
    await assert.rejects(
      waitForAcceptanceInputHydration(state.harness.page, execution, newBaseline),
      /synthetic hydration timeout/,
    );
  });
});

test('transition rejects missing, malformed, and wrong-phase fixture contracts before planning', async () => {
  await withAcceptanceBuild(async root => {
    const state = createTransitionHarness(root);
    await assert.rejects(
      transitionAcceptanceEditorFixture({ harness: state.harness }),
      /editorInputFixture is invalid/,
    );
    await assert.rejects(
      transitionAcceptanceEditorFixture({ harness: state.harness, editorInputFixture: { fixtureId: 'malformed' } }),
      /editorInputFixture is invalid/,
    );
  });
});

test('H4B launch and retained transitions share one authoritative fixture init implementation', async () => {
  const [harnessSource, retainedSource, h4bSource] = await Promise.all([
    readFile(new URL('./medclip-browser-harness.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./retained-execution-browser-handlers.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./v24abc-r11e-h4b-smoke.mjs', import.meta.url), 'utf8'),
  ]);
  assert.equal((harnessSource.match(/export function acceptanceEditorFixtureInitScript/g) ?? []).length, 1);
  assert.match(harnessSource, /context\.addInitScript\(acceptanceEditorFixtureInitScript/);
  assert.match(harnessSource, /transitionAcceptanceEditorFixture/);
  assert.doesNotMatch(retainedSource, /addInitScript|__MEDCLIP_ACCEPTANCE_INPUT_EVIDENCE__|localStorage\.setItem/);
  assert.match(h4bSource, /editorInputFixture: fixture/);
});
