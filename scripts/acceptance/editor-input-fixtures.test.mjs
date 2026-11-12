import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionEditorFixtureV1,
  createImmutableRepetitionEditorFixtureV1,
  fixtureContainsForbiddenDownstreamState,
  validateAcceptanceEditorFixtureV1,
} from './editor-input-fixtures.mjs';
import { auditR11EScenarioContracts, loadExecutionScenario, loadRepairScenario } from './v24abc-r11e-scenario-contract.mjs';

test('execution Node fixture converts to a valid browser input fixture', () => {
  const fixture = createExecutionEditorFixtureV1();
  assert.equal(fixture.fixtureId, 'medical-review-execution-v1');
  assert.equal(fixture.initialProject.captions.length, 5);
  assert.equal(fixture.initialProject.tracks[0].clips[0].assetId, 'asset-consultation');
  assert.equal(fixture.inputEvidence.semanticEvidence.length, 12);
  assert.equal(fixture.inputEvidence.rhythmEvidence.sourceDurationMs, 10_000);
  assert.deepEqual(loadExecutionScenario(), fixture);
});

test('immutable repair Node fixture contains only the H4A upstream evidence variant', () => {
  const fixture = createImmutableRepetitionEditorFixtureV1();
  const consultation = fixture.inputEvidence.semanticEvidence.find(item => item.assetId === 'asset-consultation').segments[0];
  const anatomy = fixture.inputEvidence.semanticEvidence.find(item => item.assetId === 'asset-anatomy').segments[0];
  assert.deepEqual(consultation.concepts.slice(0, 2), ['consultation', 'anatomy']);
  assert.equal(consultation.action, 'consultation');
  assert.equal(consultation.confidence, 0.95);
  assert.equal(anatomy.action, 'consultation');
  assert.equal(anatomy.confidence, 0.87);
  assert.equal(anatomy.usability, 0.43);
  assert.deepEqual(loadRepairScenario(), fixture);
});

test('fixture validation rejects malformed shape, unknown version, and downstream state', () => {
  const fixture = createExecutionEditorFixtureV1();
  assert.throws(() => validateAcceptanceEditorFixtureV1({ ...fixture, fixtureVersion: 2 }), /Unsupported/);
  assert.throws(() => validateAcceptanceEditorFixtureV1({ ...fixture, unexpected: true }), /unknown/);
  assert.throws(() => validateAcceptanceEditorFixtureV1({ ...fixture, proposal: {} }), /forbidden/);
  assert.equal(fixtureContainsForbiddenDownstreamState(fixture), false);
  assert.equal(fixtureContainsForbiddenDownstreamState({ ...fixture, repairResult: {} }), true);
  assert.equal(JSON.stringify(fixture).includes('LOW_SEMANTIC_SUPPORT'), false);
});

test('production planning, review, execution, evaluator, repair, and one re-evaluation prove immutable viability', () => {
  const audit = auditR11EScenarioContracts();
  assert.ok(audit.executionScenario.actions >= 1);
  assert.deepEqual(audit.executionScenario.protectedClipIds, ['clip-0']);
  assert.equal(audit.executionScenario.modifyAssetId, 'asset-ecg-alt');
  assert.deepEqual(audit.repairScenario.defectCodes, ['IMMEDIATE_ASSET_REPEAT', 'RECENT_ASSET_REUSE']);
  assert.equal(audit.repairScenario.repairEligibility, 'ELIGIBLE');
  assert.equal(audit.repairScenario.repairActionType, 'MATCH_ASSET_TO_SEGMENT');
  assert.equal(audit.repairScenario.repairClipId, 'clip-1');
  assert.equal(audit.repairScenario.repairAssetId, 'asset-anatomy');
  assert.equal(audit.repairScenario.duplicateTargetHandling, 'DUPLICATE_TARGET_CONFLICT');
  assert.equal(audit.repairScenario.humanReviewLifecycle, 'REPAIR_READY_TO_EXECUTE');
  assert.equal(audit.repairScenario.repairExecutionStatus, 'APPLIED');
  assert.equal(audit.repairScenario.protectedContentUnchanged, true);
  assert.equal(audit.repairScenario.historyEntryCount, 1);
  assert.equal(audit.repairScenario.reEvaluationCount, 1);
  assert.equal(audit.repairScenario.remainingDefectCount, 0);
  assert.equal(audit.repairScenario.secondRepairRound, false);
  assert.equal(audit.repairScenario.finalStatus, 'REPAIR_FINAL_PASS');
});
