import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTO_OPEN_EDITOR_SELECTOR,
  isAutoOpenedProjectEditorHydrated,
  waitForAutoOpenedProjectEditor,
} from './video-ai-reorder-browser-adapter.mjs';
import {
  GATE_CODES,
  SafeAcceptanceGateError,
  formatAcceptanceFailure,
  gateScope,
} from './video-ai-reorder-diagnostics.mjs';
import { buildOwnedAssetAcceptanceFixtureThroughEditor } from './video-ai-owned-asset-fixture.ts';
import { REORDER_TIMED_SUBTITLE_FIXTURE } from './video-ai-reorder-subtitle-fixture.ts';

const rawSecret = [
  'Bearer project-open-secret',
  'project-id-private',
  'localStorage-content-private',
  'https://private.invalid/project?signed=secret',
  'raw-response-body',
  'credential-value-private',
  'editorContext-private',
].join('|');

async function expectSafeFailure(action, gate, substage) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof SafeAcceptanceGateError);
    assert.equal(error.gate, gate);
    assert.equal(error.code, GATE_CODES[gate]);
    assert.equal(error.substage, substage);
    const formatted = formatAcceptanceFailure(error);
    assert.match(formatted, new RegExp(`GATE = ${gate}`));
    assert.match(formatted, new RegExp(`CODE = ${GATE_CODES[gate]}`));
    assert.match(formatted, new RegExp(`SUBSTAGE = ${substage}`));
    const outputs = [JSON.stringify(error), formatted, String(error), error.stack];
    for (const output of outputs) {
      for (const secret of rawSecret.split('|')) assert.ok(!output.includes(secret));
    }
    return true;
  });
}

function projectOpenPage({ autoOpen = true, hydrated = true } = {}) {
  const actions = [];
  const page = {
    locator(selector) {
      actions.push(`locator:${selector}`);
      if (selector === '.continue-edit-button') assert.fail('stale continue button queried');
      assert.equal(selector, AUTO_OPEN_EDITOR_SELECTOR);
      return {
        async waitFor(options) {
          actions.push(`wait:${selector}:${options.state}:${options.timeout}`);
          if (!autoOpen) throw new Error(rawSecret);
        },
        async click() { assert.fail('manual project-open click attempted'); },
      };
    },
    url() { return 'http://localhost:3000/editor'; },
    async waitForFunction(predicate, argument, options) {
      actions.push(`hydrate:${options.timeout}`);
      assert.equal(predicate, isAutoOpenedProjectEditorHydrated);
      assert.equal(argument, undefined);
      if (!hydrated) throw new Error(rawSecret);
    },
  };
  return { page, actions };
}

test('PROJECT_OPEN passes when the generated TimelineEditor auto-opens and hydrates', async () => {
  const { page, actions } = projectOpenPage();
  const substages = [];
  await gateScope('PROJECT_OPEN', async (_stage, substage) => {
    await waitForAutoOpenedProjectEditor(page, value => {
      substages.push(value);
      substage(value);
    });
  });
  assert.deepEqual(substages, ['PROJECT_AUTO_OPEN_WAIT', 'PROJECT_STATE_HYDRATION']);
  assert.deepEqual(actions, [
    `locator:${AUTO_OPEN_EDITOR_SELECTOR}`,
    `wait:${AUTO_OPEN_EDITOR_SELECTOR}:visible:60000`,
    'hydrate:60000',
  ]);
});

test('hidden continue button is ignored when TimelineEditor is already visible', async () => {
  const { page, actions } = projectOpenPage();
  page.hiddenHero = { selector: '.continue-edit-button', visible: false };
  await waitForAutoOpenedProjectEditor(page);
  assert.ok(!actions.some(action => action.includes('continue-edit-button')));
});

test('PROJECT_OPEN auto-open timeout reports only its safe substage', async () => {
  const { page } = projectOpenPage({ autoOpen:false });
  await expectSafeFailure(
    () => gateScope('PROJECT_OPEN', async (_stage, substage) => {
      await waitForAutoOpenedProjectEditor(page, substage);
    }),
    'PROJECT_OPEN',
    'PROJECT_AUTO_OPEN_WAIT',
  );
});

test('PROJECT_OPEN hydration failure reports only its safe substage', async () => {
  const { page } = projectOpenPage({ hydrated:false });
  await expectSafeFailure(
    () => gateScope('PROJECT_OPEN', async (_stage, substage) => {
      await waitForAutoOpenedProjectEditor(page, substage);
    }),
    'PROJECT_OPEN',
    'PROJECT_STATE_HYDRATION',
  );
});

test('hydration condition requires current route, persisted project, and rendered clips', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalHTMLElement = globalThis.HTMLElement;
  class TestHTMLElement {
    constructor(clipCount) { this.clipCount = clipCount; }
    querySelectorAll(selector) {
      assert.equal(selector, '.timeline-clip');
      return Array.from({ length:this.clipCount });
    }
  }
  const project = {
    schemaVersion:2,
    tracks:[{ type:'video', clips:[{ id:'a' },{ id:'b' },{ id:'c' }] }],
  };
  const shell = new TestHTMLElement(3);
  try {
    globalThis.HTMLElement = TestHTMLElement;
    globalThis.window = {
      location:{ pathname:'/editor' },
      localStorage:{ getItem:() => JSON.stringify(project) },
    };
    globalThis.document = { querySelector:selector => selector === AUTO_OPEN_EDITOR_SELECTOR ? shell : null };
    assert.equal(isAutoOpenedProjectEditorHydrated(), true);
    shell.clipCount = 2;
    assert.equal(isAutoOpenedProjectEditorHydrated(), false);
    globalThis.window.location.pathname = '/other';
    assert.equal(isAutoOpenedProjectEditorHydrated(), false);
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.HTMLElement = originalHTMLElement;
  }
});

test('project persistence failure preserves PROJECT_GENERATION with a safe substage', async () => {
  let waitCalls = 0;
  const locator = selector => ({
    nth:() => locator(selector),
    async setInputFiles() {},
    async waitFor() {},
    async click() {},
    async fill() {},
    async isChecked() { return true; },
    async check() {},
  });
  const page = {
    locator,
    async waitForFunction() {
      waitCalls++;
      if (waitCalls === 2) throw new Error(rawSecret);
    },
    async evaluate() { assert.fail('project state read after failed persistence'); },
  };
  await expectSafeFailure(
    () => gateScope('OWNED_MEDIA_SETUP', async (stage, substage) => {
      await buildOwnedAssetAcceptanceFixtureThroughEditor(page, {
        video:{ name:'video-a.mp4', mimeType:'video/mp4', buffer:new Uint8Array([0]) },
        audio:{ name:'audio.wav', mimeType:'audio/wav', buffer:new Uint8Array([0]) },
        subtitleText:REORDER_TIMED_SUBTITLE_FIXTURE,
        diagnosticStage:stage,
        diagnosticSubstage:substage,
      });
    }),
    'PROJECT_GENERATION',
    'PROJECT_PERSISTENCE_WAIT',
  );
});
