import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createExecutionEditorFixtureV1 } from './editor-input-fixtures.mjs';
import { canonicalProjectFingerprint, canonicalProjectSnapshot } from './medclip-browser-harness.mjs';
import {
  RETAINED_REDO_ACCESSIBLE_NAME,
  RETAINED_TIMELINE_EDITOR_SELECTOR,
  RETAINED_UNDO_ACCESSIBLE_NAME,
  ensureRetainedTimelineEditorOpen,
  exerciseRetainedExecutionUndoRedo,
} from './retained-execution-browser-handlers.mjs';

function projectPair() {
  const pre = structuredClone(createExecutionEditorFixtureV1().initialProject);
  const post = structuredClone(pre);
  post.title = `${pre.title} executed`;
  post.tracks[0].clips[0].assetId = post.assets[1].id;
  post.updatedAt = '2026-10-29T12:00:00.000Z';
  return { pre, post };
}

function undoRedoPage({ initiallyOpen = false, missingControl = null } = {}) {
  const { pre, post } = projectPair();
  let editorOpen = initiallyOpen;
  let project = structuredClone(post);
  let history = initiallyOpen ? [structuredClone(pre)] : [];
  let future = [];
  let renderVersion = 0;
  let openClicks = 0;
  const resolutions = { Undo: 0, Redo: 0 };

  const control = (label, name) => {
    const version = renderVersion;
    resolutions[label] += 1;
    const exists = editorOpen && missingControl !== label;
    const assertCurrent = () => {
      if (version !== renderVersion) throw new Error(`stale ${label} control`);
    };
    const disabled = () => label === 'Undo' ? history.length === 0 : future.length === 0;
    return {
      async count() { return exists ? 1 : 0; },
      async isVisible() { return exists; },
      async isEnabled() { assertCurrent(); return exists && !disabled(); },
      async isDisabled() { assertCurrent(); return !exists || disabled(); },
      async click() {
        assertCurrent();
        assert.equal(exists, true);
        assert.equal(disabled(), false);
        if (name === RETAINED_UNDO_ACCESSIBLE_NAME) {
          future = [structuredClone(project)];
          project = history.pop();
        } else {
          history = [structuredClone(project)];
          project = future.pop();
        }
        renderVersion += 1;
      },
    };
  };

  const toolbar = {
    getByRole(_role, { name }) {
      if (name === RETAINED_UNDO_ACCESSIBLE_NAME) return control('Undo', name);
      if (name === RETAINED_REDO_ACCESSIBLE_NAME) return control('Redo', name);
      throw new Error(`unexpected accessible name: ${name}`);
    },
  };
  const editor = {
    async count() { return editorOpen ? 1 : 0; },
    async isVisible() { return editorOpen; },
    locator(selector) {
      assert.equal(selector, '.editor-toolbar');
      return toolbar;
    },
    async waitFor({ state }) {
      assert.equal(state, 'visible');
      if (!editorOpen) throw new Error('editor did not open');
    },
  };
  const open = {
    async count() { return editorOpen ? 0 : 1; },
    async isVisible() { return !editorOpen; },
    async isEnabled() { return !editorOpen; },
    async click() {
      openClicks += 1;
      editorOpen = true;
      history = [structuredClone(pre)];
      future = [];
      renderVersion += 1;
    },
  };
  const page = {
    locator(selector) {
      if (selector === RETAINED_TIMELINE_EDITOR_SELECTOR) return editor;
      if (selector === 'button.continue-edit-button') return open;
      throw new Error(`unexpected selector: ${selector}`);
    },
    async evaluate() { return structuredClone(project); },
    async waitForFunction(_predicate, expected) {
      if (Object.hasOwn(expected, 'fingerprint')) {
        if (canonicalProjectFingerprint(project) !== expected.fingerprint) throw new Error('fingerprint mismatch');
        return;
      }
      const label = expected.name === RETAINED_UNDO_ACCESSIBLE_NAME ? 'Undo' : 'Redo';
      const exists = editorOpen && missingControl !== label;
      const disabled = label === 'Undo' ? history.length === 0 : future.length === 0;
      if (!exists || disabled !== expected.expectedDisabled) throw new Error(`${label} state unavailable`);
    },
  };
  return {
    page, pre, post,
    openClicks: () => openClicks,
    resolutions: () => ({ ...resolutions }),
    project: () => structuredClone(project),
  };
}

test('production-scoped Undo and Redo controls are discovered after the supported editor-open interaction', async () => {
  const fixture = undoRedoPage();
  assert.deepEqual(await ensureRetainedTimelineEditorOpen({ page: fixture.page }), {
    opened: true, editorVisible: true,
  });
  assert.equal(fixture.openClicks(), 1);
  assert.equal(RETAINED_TIMELINE_EDITOR_SELECTOR,
    'section.timeline-editor-shell[aria-label="\u751f\u6210\u540e\u7ee7\u7eed\u526a\u8f91"]');
  assert.equal(RETAINED_UNDO_ACCESSIBLE_NAME, '\u21b6 \u64a4\u9500');
  assert.equal(RETAINED_REDO_ACCESSIBLE_NAME, '\u21b7 \u91cd\u505a');
});

test('retained selectors and opening path stay aligned with the production TimelineEditor source contract', async () => {
  const [timeline, studio] = await Promise.all([
    readFile(new URL('../../app/TimelineEditor.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/editor/EditorStudio.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(timeline, /<section aria-label="\u751f\u6210\u540e\u7ee7\u7eed\u526a\u8f91" className=\{`timeline-editor-shell/);
  assert.match(timeline, /<button disabled=\{!historyRef\.current\.length\} onClick=\{undo\} type="button">\u21b6 \u64a4\u9500<\/button>/);
  assert.match(timeline, /<button disabled=\{!futureRef\.current\.length\} onClick=\{redo\} type="button">\u21b7 \u91cd\u505a<\/button>/);
  assert.match(studio, /className="continue-edit-button" onClick=\{\(\) => setEditorOpen\(true\)\}/);
  const executeStart = studio.indexOf('const executeApprovedProposal');
  const executeEnd = studio.indexOf('const handleRepairReviewDecision', executeStart);
  assert.doesNotMatch(studio.slice(executeStart, executeEnd), /setEditorOpen\(true\)/);
});

test('already-open TimelineEditor is preserved without a duplicate opening interaction', async () => {
  const fixture = undoRedoPage({ initiallyOpen: true });
  assert.deepEqual(await ensureRetainedTimelineEditorOpen({ page: fixture.page }), {
    opened: false, editorVisible: true,
  });
  assert.equal(fixture.openClicks(), 0);
});

test('one real Undo and Redo restore exact canonical projects and fingerprints', async () => {
  const fixture = undoRedoPage();
  const result = await exerciseRetainedExecutionUndoRedo({
    page: fixture.page,
    preProjectFingerprint: canonicalProjectFingerprint(fixture.pre),
    executedProjectFingerprint: canonicalProjectFingerprint(fixture.post),
    preProjectSnapshot: canonicalProjectSnapshot(fixture.pre),
    executedProjectSnapshot: canonicalProjectSnapshot(fixture.post),
  });
  assert.deepEqual(result, {
    exactUndo: true, exactRedo: true, logicalHistoryEntryCount: 1, editorOpened: true,
  });
  assert.deepEqual(canonicalProjectSnapshot(fixture.project()), canonicalProjectSnapshot(fixture.post));
});

test('Undo and Redo are re-resolved after every render and no stale control is reused', async () => {
  const fixture = undoRedoPage();
  await exerciseRetainedExecutionUndoRedo({
    page: fixture.page,
    preProjectFingerprint: canonicalProjectFingerprint(fixture.pre),
    executedProjectFingerprint: canonicalProjectFingerprint(fixture.post),
    preProjectSnapshot: canonicalProjectSnapshot(fixture.pre),
    executedProjectSnapshot: canonicalProjectSnapshot(fixture.post),
  });
  assert.deepEqual(fixture.resolutions(), { Undo: 2, Redo: 3 });
});

test('missing current Undo control fails closed with bounded scope and visibility evidence', async () => {
  const fixture = undoRedoPage({ missingControl: 'Undo' });
  await assert.rejects(
    exerciseRetainedExecutionUndoRedo({
      page: fixture.page,
      preProjectFingerprint: canonicalProjectFingerprint(fixture.pre),
      executedProjectFingerprint: canonicalProjectFingerprint(fixture.post),
      preProjectSnapshot: canonicalProjectSnapshot(fixture.pre),
      executedProjectSnapshot: canonicalProjectSnapshot(fixture.post),
    }),
    error => {
      assert.match(error.message, /Undo control state unavailable/);
      assert.match(error.message, /timeline-editor-shell/);
      assert.match(error.message, /"editorVisible":true/);
      assert.match(error.message, /"candidateMatchCount":0/);
      assert.doesNotMatch(error.message, /tracks|assets|captions|localStorage/);
      return true;
    },
  );
});

test('retained Undo/Redo implementation uses no fixed sleep, direct history access, or global button index', async () => {
  const source = await readFile(new URL('./retained-execution-browser-handlers.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function waitFingerprint');
  const end = source.indexOf('export function verifyRetainedExecutionFingerprintSupport', start);
  const implementation = source.slice(start, end);
  assert.doesNotMatch(implementation, /waitForTimeout|setTimeout|sleep\s*\(|historyRef|futureRef|\.nth\s*\(/);
  assert.match(implementation, /button\.continue-edit-button/);
  assert.match(implementation, /RETAINED_TIMELINE_EDITOR_SELECTOR/);
  assert.match(implementation, /readCanonicalProjectSnapshot/);
});
