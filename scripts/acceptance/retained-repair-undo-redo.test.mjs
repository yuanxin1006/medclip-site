import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { canonicalProjectFingerprint } from './medclip-browser-harness.mjs';
import {
  RETAINED_REDO_ACCESSIBLE_NAME,
  RETAINED_TIMELINE_EDITOR_SELECTOR,
  RETAINED_UNDO_ACCESSIBLE_NAME,
} from './retained-execution-browser-handlers.mjs';
import { exerciseRetainedRepairUndoRedo } from './retained-repair-browser-handlers.mjs';
import { loadRepairScenarioEvidence } from './v24abc-r11e-scenario-contract.mjs';

function repairUndoRedoPage({ historyReady = true, missingControl = null } = {}) {
  const evidence = loadRepairScenarioEvidence();
  const state = {
    proposal: evidence.repairProposal,
    review: evidence.repairResult.repairReview,
    result: evidence.repairResult,
    evaluation: evidence.repairResult.reEvaluation,
  };
  const initialPre = structuredClone(evidence.execution.history.undoProject);
  const pre = structuredClone(evidence.repairResult.history.undoProject);
  const post = structuredClone(evidence.repairResult.history.redoProject);
  let project = structuredClone(post);
  let history = historyReady ? [structuredClone(initialPre), structuredClone(pre)] : [];
  let future = [];
  let renderVersion = 0;
  const resolutions = { Undo: 0, Redo: 0 };

  const control = (label, name) => {
    const version = renderVersion;
    const exists = missingControl !== label;
    resolutions[label] += 1;
    const disabled = () => label === 'Undo' ? history.length === 0 : future.length === 0;
    const current = () => assert.equal(version, renderVersion, `stale ${label} control reused`);
    return {
      async count() { return exists ? 1 : 0; },
      async isVisible() { return exists; },
      async isEnabled() { current(); return exists && !disabled(); },
      async isDisabled() { current(); return !exists || disabled(); },
      async click() {
        current();
        assert.equal(exists, true);
        assert.equal(disabled(), false);
        if (name === RETAINED_UNDO_ACCESSIBLE_NAME) {
          future = [structuredClone(project)];
          project = history.pop();
        } else {
          history.push(structuredClone(project));
          project = future.pop();
        }
        renderVersion += 1;
      },
    };
  };
  const editor = {
    async count() { return 1; },
    async isVisible() { return true; },
    locator(selector) {
      assert.equal(selector, '.editor-toolbar');
      return { getByRole(_role, { name }) {
        if (name === RETAINED_UNDO_ACCESSIBLE_NAME) return control('Undo', name);
        if (name === RETAINED_REDO_ACCESSIBLE_NAME) return control('Redo', name);
        throw new Error(`unexpected control ${name}`);
      } };
    },
  };
  const page = {
    async evaluate(callback, argument) {
      if (callback.name === 'inspectCurrentMountedRepairState') return structuredClone(state);
      if (typeof argument === 'string') return structuredClone(project);
      throw new Error(`unexpected evaluate callback ${callback.name}`);
    },
    locator(selector) {
      if (selector === RETAINED_TIMELINE_EDITOR_SELECTOR) return editor;
      throw new Error(`unexpected selector ${selector}`);
    },
    async waitForFunction(_predicate, expected) {
      if (Object.hasOwn(expected, 'fingerprint')) {
        if (canonicalProjectFingerprint(project) !== expected.fingerprint) throw new Error('fingerprint unavailable');
        return;
      }
      const label = expected.name === RETAINED_UNDO_ACCESSIBLE_NAME ? 'Undo' : 'Redo';
      const exists = missingControl !== label;
      const disabled = label === 'Undo' ? history.length === 0 : future.length === 0;
      if (!exists || disabled !== expected.expectedDisabled) throw new Error(`${label} state unavailable`);
    },
  };
  return { page, pre, post, project: () => structuredClone(project), resolutions: () => ({ ...resolutions }) };
}

test('repair history with an earlier execution entry treats enabled Undo after repair Undo as valid', async () => {
  const fixture = repairUndoRedoPage();
  const result = await exerciseRetainedRepairUndoRedo({ page: fixture.page });
  assert.equal(result.exactUndo, true);
  assert.equal(result.exactRedo, true);
  assert.equal(result.preRepairFingerprint, canonicalProjectFingerprint(fixture.pre));
  assert.equal(result.postRepairFingerprint, canonicalProjectFingerprint(fixture.post));
  assert.deepEqual(fixture.project(), fixture.post);
});

test('repair Undo and Redo controls are freshly resolved after each history render', async () => {
  const fixture = repairUndoRedoPage();
  await exerciseRetainedRepairUndoRedo({ page: fixture.page });
  assert.deepEqual(fixture.resolutions(), { Undo: 2, Redo: 3 });
});

test('visible but disabled repair Undo fails closed when committed history is not ready', async () => {
  const fixture = repairUndoRedoPage({ historyReady: false });
  await assert.rejects(
    exerciseRetainedRepairUndoRedo({ page: fixture.page }),
    error => {
      assert.match(error.message, /Undo control state unavailable/);
      assert.match(error.message, /"editorVisible":true/);
      assert.match(error.message, /"candidateMatchCount":1/);
      return true;
    },
  );
});

test('missing repair Undo control fails closed with bounded control evidence', async () => {
  const fixture = repairUndoRedoPage({ missingControl: 'Undo' });
  await assert.rejects(
    exerciseRetainedRepairUndoRedo({ page: fixture.page }),
    error => {
      assert.match(error.message, /Undo control state unavailable/);
      assert.match(error.message, /"candidateMatchCount":0/);
      assert.doesNotMatch(error.message, /tracks|assets|captions|localStorage/);
      return true;
    },
  );
});

test('repair Undo/Redo state contract keeps S4A defaults and uses no fixed sleep', async () => {
  const [repairSource, executionSource] = await Promise.all([
    readFile(new URL('./retained-repair-browser-handlers.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./retained-execution-browser-handlers.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(repairSource, /expectedUndoDisabledAfterUndo:\s*false/);
  assert.match(executionSource, /expectedUndoDisabledAfterUndo\s*=\s*true/);
  const start = executionSource.indexOf('export async function exerciseRetainedExecutionUndoRedo');
  const implementation = executionSource.slice(start, executionSource.indexOf(
    'export function verifyRetainedExecutionFingerprintSupport', start,
  ));
  assert.doesNotMatch(implementation, /waitForTimeout|setTimeout|sleep\s*\(/);
});
