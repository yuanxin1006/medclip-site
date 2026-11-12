import { SafeAcceptanceGateError } from './video-ai-reorder-diagnostics.mjs';

export const POSITION_SCALE_SUBSTAGES = Object.freeze([
  'POSITION_SCALE_REMOTE_VERSION','POSITION_SCALE_REMOTE_METADATA_EXEC','POSITION_SCALE_REMOTE_METADATA_PARSE',
  'POSITION_SCALE_REMOTE_STATUS','POSITION_SCALE_REMOTE_VERSION_CHECK','POSITION_SCALE_AUTH',
  'POSITION_SCALE_EDITOR_LOAD','POSITION_SCALE_PROVIDER_METADATA','POSITION_SCALE_PROVIDER_SELECT',
  'POSITION_SCALE_REQUIREMENT_INPUT','POSITION_SCALE_GENERATION_INTERCEPT','POSITION_SCALE_RESPONSE_ENVELOPE','POSITION_SCALE_RESPONSE_EXTRACT',
  'POSITION_SCALE_RESPONSE_INTERCEPT','POSITION_SCALE_RESPONSE_CONSUMED','POSITION_SCALE_PLAN_REJECTED_BEFORE_APPLY',
  'POSITION_SCALE_PLAN_ACCEPTED','POSITION_SCALE_TARGET_CONFIRMATION','POSITION_SCALE_TARGET_CONFIRMED',
  'POSITION_SCALE_UI_SELECTION','POSITION_SCALE_UI_OBSERVATION','POSITION_SCALE_PREVIEW_OBSERVATION',
  'PREVIEW_TARGET_BINDING','PREVIEW_ELEMENT','PREVIEW_TRANSFORM_PRESENT',
  'PREVIEW_TRANSLATE_X','PREVIEW_TRANSLATE_Y','PREVIEW_SCALE',
  'UI_SELECTION_DIALOG_READY','UI_SELECTION_EDITOR_READY','UI_SELECTION_TIMELINE_READY',
  'UI_SELECTION_MAPPING','UI_SELECTION_MAPPING_PROJECT_TRACK','UI_SELECTION_MAPPING_PROJECT_TRACK_ZERO_MATCH',
  'UI_SELECTION_MAPPING_PROJECT_TRACK_MULTI_MATCH','UI_SELECTION_MAPPING_PROJECT_TRACK_KIND',
  'UI_SELECTION_MAPPING_PROJECT_TRACK_TARGET_ID','UI_SELECTION_MAPPING_PROJECT_TRACK_TRACK_ID',
  'UI_SELECTION_MAPPING_PROJECT_TRACK_FIXTURE_ID','UI_SELECTION_MAPPING_PROJECT_TRACK_ACTION_ID',
  'UI_SELECTION_MAPPING_PROJECT_TRACK_BASELINE_ID','UI_SELECTION_MAPPING_PROJECT_TRACK_POST_PLAN_ID',
  'UI_SELECTION_MAPPING_TRACK_CONTAINER',
  'UI_SELECTION_MAPPING_LOCAL_INDEX','UI_SELECTION_MAPPING_DOM_COUNT',
  'UI_SELECTION_CLICK','UI_SELECTION_SELECTED_STATE','UI_SELECTION_PROPERTY_GRID',
  'POSITION_SCALE_PRODUCT_APPLY_UI','POSITION_SCALE_APPLY_OBSERVER_CONFLICT',
  'POSITION_SCALE_TARGET_RESOLVED','POSITION_SCALE_PRODUCT_APPLY',
  'POSITION_SCALE_PRODUCT_APPLY_OBSERVER_CONFLICT',
  'POSITION_SCALE_RESPONSE_OR_PRODUCT_ERROR',
  'POSITION_SCALE_HISTORY',
  'HISTORY_UNDO_CONTROL_FOUND','HISTORY_UNDO_CONTROL_ENABLED','HISTORY_PRE_EDIT_SNAPSHOT',
  'UNDO_CLICK','UNDO_PROJECT_TRANSITION','UNDO_C_RESELECTION','UNDO_UI_OBSERVATION',
  'UNDO_PREVIEW_BINDING','UNDO_PREVIEW_OBSERVATION','HISTORY_UNDO_RESULT',
  'HISTORY_REDO_CONTROL_FOUND','HISTORY_REDO_CONTROL_ENABLED',
  'REDO_CLICK','REDO_PROJECT_TRANSITION','REDO_C_RESELECTION','REDO_UI_OBSERVATION',
  'REDO_PREVIEW_BINDING','REDO_PREVIEW_OBSERVATION','HISTORY_REDO_RESULT',
  'POSITION_SCALE_OWNED_FIXTURE',
  'POSITION_SCALE_FIXTURE_MEDIA_INPUTS','POSITION_SCALE_FIXTURE_PROJECT_RESET',
  'POSITION_SCALE_FIXTURE_ASSET_A','POSITION_SCALE_FIXTURE_ASSET_B','POSITION_SCALE_FIXTURE_ASSET_C',
  'POSITION_SCALE_FIXTURE_PERSISTENCE','POSITION_SCALE_FIXTURE_ORDER',
  'POSITION_SCALE_SAFE_CONTEXT','POSITION_SCALE_ACTION_FIXTURE_SHAPE','POSITION_SCALE_ACTION_TARGET',
  'POSITION_SCALE_FIXTURE_BASELINE',
  'POSITION_SCALE_ACTION_PARSE','POSITION_SCALE_ACTION_VALIDATE','POSITION_SCALE_ACTION_APPLY',
  'POSITION_SCALE_ACTION_HISTORY','POSITION_SCALE_ACTION_PERSIST',
  'POSITION_SCALE_FINAL_TRANSFORM','POSITION_SCALE_PRESERVATION',
  'POSITION_SCALE_PREVIEW','POSITION_SCALE_EXPORT','POSITION_SCALE_PERSISTENCE',
  'POSITION_SCALE_UNDO','POSITION_SCALE_REDO','POSITION_SCALE_PROVIDER_COUNT',
]);

export function classifyPositionScaleEvidence(evidence = {}) {
  if (evidence.providerGuardViolated === true) return { result:'FAIL', substage:'POSITION_SCALE_PROVIDER_COUNT' };
  if (evidence.interceptMatched !== true || evidence.responseSent !== true)
    return { result:'FAIL', substage:'POSITION_SCALE_RESPONSE_INTERCEPT' };
  if (evidence.envelopeValid !== true) return { result:'FAIL', substage:'POSITION_SCALE_RESPONSE_ENVELOPE' };
  if (evidence.responseConsumed !== true) return { result:'FAIL', substage:'POSITION_SCALE_RESPONSE_CONSUMED' };
  if (evidence.knownPlanRejection === true) return { result:'FAIL', substage:'POSITION_SCALE_PLAN_REJECTED_BEFORE_APPLY' };
  if (evidence.productError === true) return { result:'FAIL', substage:'POSITION_SCALE_RESPONSE_OR_PRODUCT_ERROR' };
  if (evidence.planAccepted !== true) return { result:'FAIL', substage:'POSITION_SCALE_RESPONSE_CONSUMED' };
  if (evidence.targetResolved !== true) return { result:'FAIL', substage:'POSITION_SCALE_TARGET_RESOLVED' };
  if (evidence.projectMutated !== true) return { result:'FAIL', substage:'POSITION_SCALE_PRODUCT_APPLY' };
  if (evidence.historyUndoControlFound === false) return { result:'FAIL', substage:'HISTORY_UNDO_CONTROL_FOUND' };
  if (evidence.historyUndoControlEnabled === false) return { result:'FAIL', substage:'HISTORY_UNDO_CONTROL_ENABLED' };
  if (evidence.historyAvailable !== true) return { result:'FAIL', substage:'POSITION_SCALE_HISTORY' };
  if (evidence.persistenceChecked === true && evidence.persistenceMatches !== true)
    return { result:'FAIL', substage:'POSITION_SCALE_PERSISTENCE' };
  return { result:'PASS', substage:null };
}

export function inspectPositionScaleUIValues(values, expectedTransform) {
  const actual = values && typeof values === 'object'
    ? {x:Number(values.x),y:Number(values.y),scale:Number(values.scale)}
    : {x:NaN,y:NaN,scale:NaN};
  const readable=Object.values(actual).every(Number.isFinite);
  return {readable,matches:readable
    && actual.x===expectedTransform.x
    && actual.y===expectedTransform.y
    && actual.scale===expectedTransform.scale,actual};
}

export function inspectPositionScaleHistoryUI(values, expectedTransform, expectedAssetId) {
  const transform=inspectPositionScaleUIValues(values,expectedTransform);
  return {...transform,matches:transform.matches
    && values?.selectedCount===1
    && values?.selectedAssetId===expectedAssetId};
}

export function inspectPositionScalePreview(value, expectedTransform) {
  const fail=substage=>({readable:false,matches:false,actual:{x:null,y:null,scale:null},substage});
  if(value?.targetBindingMatches!==true) return fail('PREVIEW_TARGET_BINDING');
  if(value?.elementCount!==1 || value?.visible!==true
    || !['video','img'].includes(value?.mediaKind)
    || value?.expectedMediaKind && value.expectedMediaKind!==value.mediaKind)
    return fail('PREVIEW_ELEMENT');
  if(typeof value?.inlineTransform!=='string' || !value.inlineTransform.trim())
    return fail('PREVIEW_TRANSFORM_PRESENT');
  const number='([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?)';
  const match=value.inlineTransform.trim().match(new RegExp(
    `^translate\\(\\s*${number}\\s*%\\s*,\\s*${number}\\s*%\\s*\\)\\s*scale\\(\\s*${number}\\s*\\)$`,'i'));
  if(!match) return fail('PREVIEW_TRANSFORM_PRESENT');
  const actual={x:Number(match[1]),y:Number(match[2]),scale:Number(match[3])};
  if(!Object.values(actual).every(Number.isFinite)) return fail('PREVIEW_TRANSFORM_PRESENT');
  if(actual.x!==expectedTransform.x) return {readable:true,matches:false,actual,substage:'PREVIEW_TRANSLATE_X'};
  if(actual.y!==expectedTransform.y) return {readable:true,matches:false,actual,substage:'PREVIEW_TRANSLATE_Y'};
  if(actual.scale!==expectedTransform.scale) return {readable:true,matches:false,actual,substage:'PREVIEW_SCALE'};
  return {readable:true,matches:true,actual,substage:null};
}

export function classifyPositionScaleApplySignals(evidence = {}) {
  if(evidence.commitCallbackInvoked!==true)
    return {result:'FAIL',classification:'GENUINE_APPLY_FAILURE',substage:'POSITION_SCALE_PRODUCT_APPLY'};
  if(evidence.uiMatches===true && evidence.previewMatches===true) {
    const observerConflict=evidence.fiberReadable===true && evidence.fiberMatches!==true;
    return {result:'PASS',classification:observerConflict?'OBSERVER_CONFLICT':'PRODUCT_APPLY_CONFIRMED',substage:null};
  }
  const contradictsPrimary=evidence.previewMatches===true || evidence.fiberMatches===true
    || evidence.persistenceMatches===true || evidence.historyAvailable===true;
  if(contradictsPrimary)
    return {result:'FAIL',classification:'OBSERVER_CONFLICT',substage:'POSITION_SCALE_PRODUCT_APPLY_OBSERVER_CONFLICT'};
  return {result:'FAIL',classification:'GENUINE_APPLY_FAILURE',substage:'POSITION_SCALE_PRODUCT_APPLY'};
}

export async function runPositionScalePostPlanFlow({confirmTarget,selectTarget,observeUI,observePreview,observeFiber,reportStage=()=>{}}) {
  reportStage('POSITION_SCALE_TARGET_CONFIRMATION');
  await confirmTarget();
  reportStage('POSITION_SCALE_TARGET_CONFIRMED');
  reportStage('POSITION_SCALE_TARGET_RESOLVED');
  reportStage('POSITION_SCALE_UI_SELECTION');
  await selectTarget();
  reportStage('POSITION_SCALE_UI_OBSERVATION');
  const ui=await observeUI();
  if(ui?.matches!==true) throw new PositionScaleGateError('POSITION_SCALE_PRODUCT_APPLY_UI');
  reportStage('POSITION_SCALE_PREVIEW_OBSERVATION');
  const preview=await observePreview();
  if(preview?.matches!==true) throw new PositionScaleGateError(
    preview?.substage ?? 'POSITION_SCALE_APPLY_OBSERVER_CONFLICT',undefined,preview?.actual);
  reportStage('POSITION_SCALE_PRODUCT_APPLY');
  let fiber='NOT_USED';
  if(typeof observeFiber==='function') {
    try { fiber=await observeFiber(); }
    catch { fiber='NOT_USED'; }
  }
  return {ui,preview,fiber};
}

export function selectTimelineEditorProjectCandidate(candidates, expectedClipIds) {
  if(!Array.isArray(candidates)) return null;
  const matches=candidates.filter(candidate=>{
    if(!candidate || candidate.ownerProjectProp!==true || candidate.hasProjectChangeCallback!==true) return false;
    const project=candidate.project;
    if(project?.schemaVersion!==2 || !Array.isArray(project.tracks)) return false;
    const ids=orderedVisualClips(project).map(clip=>clip.id);
    return ids.length===expectedClipIds.length && ids.every((id,index)=>id===expectedClipIds[index]);
  });
  return matches.length===1 ? matches[0].project : null;
}

function orderedVisualClips(project) {
  if (!project || !Array.isArray(project.tracks)) return [];
  return project.tracks.filter(track=>track && ['video','broll'].includes(track.type))
    .flatMap(track=>Array.isArray(track.clips)?track.clips:[])
    .sort((a,b)=>a.timelineStartMs-b.timelineStartMs);
}

export function resolvePositionScaleTimelineDomIndex(project, expectedClipIds, targetId, renderedClipCount) {
  const result=resolvePositionScaleTimelineMapping(project,expectedClipIds,targetId);
  if(!result.mapping) return null;
  const domOrder=['video','broll'].flatMap(type=>project.tracks
    .filter(track=>track?.type===type && Array.isArray(track.clips)).flatMap(track=>track.clips));
  if(domOrder.length!==renderedClipCount || domOrder.length!==orderedVisualClips(project).length) return null;
  const globalIndex=domOrder.findIndex(clip=>clip.id===targetId);
  return globalIndex>=0 ? globalIndex : null;
}

export function comparePositionScaleTargetIdentity(referenceProject, candidateProject, targetId) {
  const fail=substage=>({matches:false,substage});
  if(typeof targetId!=='string' || !targetId.trim())
    return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_TARGET_ID');
  const locate=project=>Array.isArray(project?.tracks)
    ? project.tracks.flatMap(track=>Array.isArray(track?.clips)
      ? track.clips.filter(clip=>clip?.id===targetId).map(clip=>({track,clip})) : []) : [];
  const reference=locate(referenceProject),candidate=locate(candidateProject);
  if(reference.length!==1) return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_BASELINE_ID');
  if(candidate.length!==1) return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_POST_PLAN_ID');
  if(reference[0].clip.trackId!==reference[0].track.id)
    return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_BASELINE_ID');
  if(candidate[0].clip.trackId!==candidate[0].track.id
    || candidate[0].clip.id!==reference[0].clip.id
    || candidate[0].clip.trackId!==reference[0].clip.trackId
    || candidate[0].track.id!==reference[0].track.id)
    return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_POST_PLAN_ID');
  return {matches:true,substage:null};
}

export function resolvePositionScaleTimelineMapping(project, expectedClipIds, targetId, identity={}) {
  const fail=substage=>({mapping:null,substage});
  if(typeof targetId!=='string' || !targetId.trim())
    return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_TARGET_ID');
  if(identity.actionTargetId!==undefined && identity.actionTargetId!==targetId)
    return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_ACTION_ID');
  if(!Array.isArray(expectedClipIds) || expectedClipIds.length!==3
    || identity.fixtureTargetId!==undefined && identity.fixtureTargetId!==expectedClipIds[2])
    return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_FIXTURE_ID');
  if(!project || !Array.isArray(project.tracks))
    return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_TARGET_ID');
  if(identity.baselineProject) {
    const baseline=comparePositionScaleTargetIdentity(identity.baselineProject,project,targetId);
    if(!baseline.matches) return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_BASELINE_ID');
  }
  const matches=project.tracks.flatMap((track,projectTrackOrdinal)=>
    Array.isArray(track?.clips) ? track.clips.flatMap((clip,localProjectTrackClipOrdinal)=>
      clip?.id===targetId ? [{track,clip,projectTrackOrdinal,localProjectTrackClipOrdinal}] : []) : []);
  if(matches.length===0) return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_ZERO_MATCH');
  if(matches.length!==1) return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_MULTI_MATCH');
  const owner=matches[0];
  const trackKind=owner.track.type;
  if(!['video','broll'].includes(trackKind)) return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_KIND');
  if(owner.clip.id!==targetId) return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_TARGET_ID');
  if(owner.clip.trackId!==owner.track.id) return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_TRACK_ID');
  if(targetId!==expectedClipIds[2]) return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_FIXTURE_ID');
  const chronological=orderedVisualClips(project);
  const chronologicalIds=chronological.map(clip=>clip?.id);
  if(chronologicalIds.length!==expectedClipIds.length
    || chronologicalIds.some((id,index)=>id!==expectedClipIds[index]))
    return fail('UI_SELECTION_MAPPING_PROJECT_TRACK_FIXTURE_ID');
  const renderedTrackOrdinal=['video','broll'].indexOf(trackKind);
  const groupedClips=project.tracks.filter(track=>track?.type===trackKind && Array.isArray(track.clips))
    .flatMap(track=>track.clips);
  const localClipOrdinal=groupedClips.findIndex(clip=>clip?.id===targetId);
  if(renderedTrackOrdinal<0 || localClipOrdinal<0
    || groupedClips.filter(clip=>clip?.id===targetId).length!==1)
    return fail('UI_SELECTION_MAPPING_LOCAL_INDEX');
  return {mapping:{trackKind,renderedTrackOrdinal,localClipOrdinal,
    projectTrackOrdinal:owner.projectTrackOrdinal,
    localProjectTrackClipOrdinal:owner.localProjectTrackClipOrdinal}};
}

export function validatePositionScaleTimelineDOMMapping(mapping, evidence={}) {
  if(!mapping || !Number.isSafeInteger(mapping.renderedTrackOrdinal)
    || mapping.renderedTrackOrdinal<0 || mapping.renderedTrackOrdinal>1)
    return {valid:false,substage:'UI_SELECTION_MAPPING_LOCAL_INDEX'};
  if(evidence.visualTrackContainerCount!==2)
    return {valid:false,substage:'UI_SELECTION_MAPPING_TRACK_CONTAINER'};
  if(!Number.isSafeInteger(evidence.trackClipCount) || !Number.isSafeInteger(mapping.localClipOrdinal)
    || mapping.localClipOrdinal<0
    || mapping.localClipOrdinal>=evidence.trackClipCount)
    return {valid:false,substage:'UI_SELECTION_MAPPING_LOCAL_INDEX'};
  if(!Number.isSafeInteger(evidence.renderedClipCount)
    || evidence.renderedClipCount!==evidence.expectedRenderedClipCount)
    return {valid:false,substage:'UI_SELECTION_MAPPING_DOM_COUNT'};
  return {valid:true,substage:null};
}

export function inspectPositionScaleTimelineSelection(value, expected) {
  const selectedIndices=Array.isArray(value?.selectedIndices)?value.selectedIndices:[];
  const selectedLocations=Array.isArray(value?.selectedLocations)?value.selectedLocations:[];
  const selectionMatches=Array.isArray(value?.selectedLocations)
    ? selectedLocations.length===1 && selectedLocations[0]?.trackOrdinal===expected.trackOrdinal
      && selectedLocations[0]?.localClipOrdinal===expected.localClipOrdinal
    : selectedIndices.length===1 && selectedIndices[0]===expected.domIndex;
  return {matches:value?.timelineVisible===true
    && value?.clipCount===expected.clipCount
    && selectionMatches
    && value?.propertyPaneKind==='素材片段'
    && value?.transformGridVisible===true
    && value?.selectedAssetId===expected.assetId};
}

export function inspectPositionScaleCommittedState(project, expectedClipIds, targetId, expectedTransform) {
  const clips=orderedVisualClips(project);
  const orderMatches=clips.length===expectedClipIds.length && clips.every((clip,index)=>clip.id===expectedClipIds[index]);
  const targetResolved=orderMatches && targetId===expectedClipIds[2] && clips[2]?.id===targetId;
  const target=targetResolved ? clips[2] : null;
  const transformMatches=Boolean(target && target.transform
    && target.transform.x===expectedTransform.x
    && target.transform.y===expectedTransform.y
    && target.transform.scale===expectedTransform.scale);
  return {targetResolved,transformMatches};
}

export async function waitForPositionScaleCommittedProject(readProject, expected, options={}) {
  if(expected.targetId!==expected.expectedClipIds?.[2])
    throw new PositionScaleGateError('POSITION_SCALE_TARGET_RESOLVED');
  const now=options.now ?? Date.now;
  const sleep=options.sleep ?? (milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds)));
  const timeoutMs=options.timeoutMs ?? 15_000;
  const pollIntervalMs=options.pollIntervalMs ?? 25;
  const deadline=now()+timeoutMs;
  while(true) {
    const project=await readProject();
    const observation=inspectPositionScaleCommittedState(project,expected.expectedClipIds,expected.targetId,expected.transform);
    if(observation.targetResolved && observation.transformMatches) return project;
    const remaining=deadline-now();
    if(remaining<=0) throw new PositionScaleGateError('POSITION_SCALE_PRODUCT_APPLY');
    await sleep(Math.min(pollIntervalMs,remaining));
  }
}
export const POSITION_SCALE_FIXTURE_REASON = 'Provider-free browser preflight: move trusted clip C right and up at 80 percent scale.';

export class PositionScaleGateError extends Error {
  constructor(substage, provenance, observedPreview) {
    super('POSITION_SCALE_PREFLIGHT:ASSERTION_FAILED');
    Object.defineProperties(this, { gate:{value:'POSITION_SCALE_PREFLIGHT',enumerable:true},
      code:{value:'ASSERTION_FAILED',enumerable:true},
      substage:{value:POSITION_SCALE_SUBSTAGES.includes(substage) ? substage : undefined,enumerable:true},
      provenance:{value:safeProvenance(provenance),enumerable:true},
      observedPreview:{value:safeObservedPreview(observedPreview),enumerable:true} });
  }
  toJSON() { return {gate:this.gate,code:this.code,...(this.substage ? {substage:this.substage} : {}),
    ...(this.provenance ? {provenance:this.provenance} : {}),...(this.observedPreview ? {observedPreview:this.observedPreview} : {})}; }
}

function safeObservedPreview(value) {
  if(!value || typeof value!=='object') return undefined;
  const safe={};
  for(const key of ['x','y','scale']) safe[key]=Number.isFinite(value[key]) ? value[key] : null;
  return safe;
}

function safeProvenance(value) {
  if (!value || typeof value !== 'object') return undefined;
  const allowedHashes = new Set(['runner','browserAdapter','diagnostics','sharedReorderBrowserAdapter','sharedOwnedMediaFixture','sharedReorderDiagnostics']);
  const hashes = value.hashes && Object.fromEntries(Object.entries(value.hashes)
    .filter(([name, hash]) => allowedHashes.has(name) && typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash)));
  const result = {
    ...(Number.isSafeInteger(value.pid) && value.pid > 0 ? {pid:value.pid} : {}),
    ...(typeof value.cwd === 'string' && value.cwd.length ? {cwd:'<local workspace>'} : {}),
    ...(typeof value.gitHead === 'string' && /^[a-f0-9]{40}$/i.test(value.gitHead) ? {gitHead:value.gitHead} : {}),
    ...(hashes && Object.keys(hashes).length ? {hashes} : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

export function safePositionScaleError(_error, substage, provenance) { return new PositionScaleGateError(substage, provenance); }
export function formatPositionScaleFailure(error) {
  const safe = error instanceof PositionScaleGateError ? error : safePositionScaleError(error);
  const lines = ['POSITION_SCALE_PREFLIGHT_BLOCKED',`GATE = ${safe.gate}`,`CODE = ${safe.code}`,
    ...(safe.substage ? [`SUBSTAGE = ${safe.substage}`] : [])];
  if (safe.provenance) {
    lines.push(`PROVENANCE PID = ${safe.provenance.pid ?? 'UNKNOWN'}`,
      `PROVENANCE CWD = ${safe.provenance.cwd ?? 'UNKNOWN'}`,
      `PROVENANCE HEAD = ${safe.provenance.gitHead ?? 'UNKNOWN'}`);
    for (const [name, hash] of Object.entries(safe.provenance.hashes ?? {}).sort(([a],[b]) => a.localeCompare(b)))
      lines.push(`PROVENANCE SHA256 ${name} = ${hash}`);
  }
  if(safe.observedPreview) {
    const value=key=>Number.isFinite(safe.observedPreview[key]) ? String(safe.observedPreview[key]) : 'NOT_READABLE';
    lines.push(`OBSERVED PREVIEW X = ${value('x')}`,`OBSERVED PREVIEW Y = ${value('y')}`,
      `OBSERVED PREVIEW SCALE = ${value('scale')}`);
  }
  lines.push('PROVIDER_CALLS = 0','RETRY = 0','FALLBACK = NONE');
  return lines.join('\n');
}
