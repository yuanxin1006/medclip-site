import assert from 'node:assert/strict';
import { parseAcceptanceEditorInputEvidenceV1 } from '../../app/editor-acceptance-input-hydration.ts';
import { parseEditorProject } from '../../app/editor-core.ts';
import { EDITOR_VISUAL_TOPICS } from '../../app/editor-caption-concepts.ts';
import { createMedicalReviewInput } from '../../app/test-support/editor-proposal-review-fixture.ts';

export const ACCEPTANCE_EDITOR_FIXTURE_VERSION = 1;
export const EXECUTION_FIXTURE_ID = 'medical-review-execution-v1';
export const IMMUTABLE_REPAIR_FIXTURE_ID = 'medical-adjacent-repetition-v1';
export const MEDICAL_REVIEW_FIXTURE_SOURCE =
  'app/test-support/editor-proposal-review-fixture.ts:createMedicalReviewInput';

const ARTIFACT_KEYS = Object.freeze([
  'fixtureId', 'fixtureVersion', 'initialProject', 'inputEvidence', 'fixtureAssertions', 'provenance',
]);
const FORBIDDEN_ARTIFACT_KEYS = new Set([
  'constraintset', 'hardconstraints', 'feasibility', 'negotiationresolution', 'readytoplan',
  'proposal', 'proposalbundle', 'collaborativeoptions', 'canonicalactions', 'humanreview',
  'safemodificationcandidates', 'executionresult', 'history', 'undoredo', 'evaluatorresult',
  'evaluation', 'typeddefect', 'typeddefects', 'defect', 'defects', 'repairproposal',
  'repairresult', 'safenochange', 'decisionexplanations', 'stalestate',
]);

function plainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, required, label) {
  assert.ok(plainRecord(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...required].sort(), `${label} has missing or unknown fields`);
}

function rejectForbiddenKeys(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  assert.equal(seen.has(value), false, 'Acceptance fixture must be acyclic');
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach(item => rejectForbiddenKeys(item, seen));
  } else {
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
      assert.equal(FORBIDDEN_ARTIFACT_KEYS.has(normalized), false,
        'Acceptance fixture contains forbidden downstream state');
      rejectForbiddenKeys(child, seen);
    }
  }
  seen.delete(value);
}

function clone(value) {
  return structuredClone(value);
}

const BROWSER_TOPIC_BY_MEDICAL_CONCEPT = new Map([
  ['consultation', 'doctor'],
  ['anatomy', 'anatomy'],
  ['ecg', 'test'],
  ['treatment', 'medicine'],
  ['recovery', 'exercise'],
]);

function browserProductionVocabulary(input) {
  const topicById = new Map(EDITOR_VISUAL_TOPICS.map(topic => [topic.id, topic]));
  const topicForConcept = concept => topicById.get(BROWSER_TOPIC_BY_MEDICAL_CONCEPT.get(concept));
  return {
    ...input,
    project: {
      ...input.project,
      captions: input.project.captions.map((caption, index) => {
        const concept = ['consultation', 'anatomy', 'ecg', 'treatment', 'recovery'][index];
        const topic = topicForConcept(concept);
        assert.ok(topic, `Missing production caption topic for ${concept}`);
        return {
          ...caption,
          text: topic.keywords[0],
          confidence: 1,
          needsReview: false,
          boundaryClipped: false,
        };
      }),
    },
    videoAnalyses: input.videoAnalyses.map(analysis => ({
      ...analysis,
      segments: analysis.segments.map(segment => {
        const aliases = segment.concepts.flatMap(concept => {
          const topic = topicForConcept(concept);
          return topic ? [topic.title] : [];
        });
        return { ...segment, concepts: [...new Set([...segment.concepts, ...aliases])] };
      }),
    })),
  };
}

export function createImmutableRepetitionPlanningInput() {
  const input = createMedicalReviewInput();
  return {
    ...input,
    videoAnalyses: input.videoAnalyses.map(analysis => {
      if (analysis.assetId === 'asset-consultation') {
        return {
          ...analysis,
          segments: analysis.segments.map(segment => ({
            ...segment,
            concepts: ['consultation', 'anatomy'],
            action: 'consultation',
            confidence: 0.95,
            usability: 0.95,
          })),
        };
      }
      if (analysis.assetId === 'asset-anatomy') {
        return {
          ...analysis,
          segments: analysis.segments.map(segment => ({
            ...segment,
            action: 'consultation',
            confidence: 0.87,
            usability: 0.43,
          })),
        };
      }
      return analysis;
    }),
  };
}

function fixtureFromInput(fixtureId, input, variant) {
  return Object.freeze({
    fixtureId,
    fixtureVersion: ACCEPTANCE_EDITOR_FIXTURE_VERSION,
    initialProject: clone(input.project),
    inputEvidence: Object.freeze({
      version: 1,
      semanticEvidence: clone(input.videoAnalyses),
      rhythmEvidence: clone(input.rhythm),
    }),
    fixtureAssertions: Object.freeze({
      expectedProjectId: input.project.id,
      semanticAssetCount: input.videoAnalyses.length,
      rhythmEvidencePresent: true,
    }),
    provenance: Object.freeze({ source: MEDICAL_REVIEW_FIXTURE_SOURCE, variant }),
  });
}

export function createExecutionEditorFixtureV1() {
  const input = browserProductionVocabulary(createMedicalReviewInput());
  input.project = {
    ...input.project,
    tracks: input.project.tracks.map(track => ({
      ...track,
      clips: track.clips.map(clip => clip.id === 'clip-0'
        ? { ...clip, assetId: 'asset-consultation', name: 'Friendly asset-consultation' }
        : clip),
    })),
  };
  return validateAcceptanceEditorFixtureV1(fixtureFromInput(
    EXECUTION_FIXTURE_ID,
    input,
    'protected clip-0 begins with the existing consultation asset; medical concepts use deterministic production caption-topic aliases',
  ));
}

export function createImmutableRepetitionEditorFixtureV1() {
  return validateAcceptanceEditorFixtureV1(fixtureFromInput(
    IMMUTABLE_REPAIR_FIXTURE_ID,
    browserProductionVocabulary(createImmutableRepetitionPlanningInput()),
    'H4A immutable adjacent-repetition variant with deterministic production caption-topic aliases',
  ));
}

export function validateAcceptanceEditorFixtureV1(value) {
  rejectForbiddenKeys(value);
  exactKeys(value, ARTIFACT_KEYS, 'AcceptanceEditorFixtureV1');
  assert.equal(value.fixtureVersion, ACCEPTANCE_EDITOR_FIXTURE_VERSION, 'Unsupported acceptance fixture version');
  assert.match(value.fixtureId, /^[a-z0-9][a-z0-9-]{0,127}$/, 'Invalid fixture identity');
  exactKeys(value.fixtureAssertions,
    ['expectedProjectId', 'semanticAssetCount', 'rhythmEvidencePresent'], 'fixtureAssertions');
  exactKeys(value.provenance, ['source', 'variant'], 'provenance');
  assert.equal(value.provenance.source, MEDICAL_REVIEW_FIXTURE_SOURCE, 'Unexpected fixture provenance');
  assert.equal(typeof value.provenance.variant, 'string');
  const project = parseEditorProject(JSON.stringify(value.initialProject));
  assert.ok(project, 'Acceptance fixture has invalid project data');
  assert.deepEqual(
    JSON.parse(JSON.stringify(project)),
    JSON.parse(JSON.stringify(value.initialProject)),
    'Acceptance fixture project does not use canonical serialized shape',
  );
  const inputEvidence = parseAcceptanceEditorInputEvidenceV1(value.inputEvidence, project);
  assert.equal(value.fixtureAssertions.expectedProjectId, project.id);
  assert.equal(value.fixtureAssertions.semanticAssetCount, inputEvidence.semanticEvidence.length);
  assert.equal(value.fixtureAssertions.rhythmEvidencePresent, inputEvidence.rhythmEvidence !== undefined);
  return Object.freeze({ ...value, initialProject: JSON.parse(JSON.stringify(project)), inputEvidence });
}

export function fixtureContainsForbiddenDownstreamState(value) {
  try {
    rejectForbiddenKeys(value);
    return false;
  } catch {
    return true;
  }
}
