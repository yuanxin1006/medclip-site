import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setup } from './video-ai-reorder-test-fixture.mjs';
import { createSafeEditorAIContext, parseAIEditingPlan, applyAIEditingPlan } from '../app/editor-ai-requirements.ts';
import { executeInternalTextTaskFixture, getInternalTextTaskFixtureDefinition } from '../supabase/functions/_shared/ai-tasks/text-fixtures.ts';
import { parseAITaskRequest } from '../supabase/functions/_shared/ai-tasks/request.ts';
import { parseEditorProject, recordProjectUndoSnapshot } from '../app/editor-core.ts';
import { assertFixtureProject, assertHistoryState, assertPositionScaleAction, assertPositionScalePreserved, assertProviderCounts, createPositionScaleAction, eligibleClips, EXPECTED_POSITION_SCALE, POSITION_SCALE_ACTION, POSITION_SCALE_ACTION_KEYS, runPositionScalePreflight, transformOf, verifyPositionScaleRemoteMetadata } from './run-video-ai-position-scale-preflight.mjs';
import { classifyPositionScaleApplySignals, classifyPositionScaleEvidence, comparePositionScaleTargetIdentity, formatPositionScaleFailure, inspectPositionScaleCommittedState, inspectPositionScaleHistoryUI, inspectPositionScalePreview, inspectPositionScaleTimelineSelection, inspectPositionScaleUIValues, PositionScaleGateError, POSITION_SCALE_FIXTURE_REASON, POSITION_SCALE_SUBSTAGES, resolvePositionScaleTimelineDomIndex, resolvePositionScaleTimelineMapping, runPositionScalePostPlanFlow, selectTimelineEditorProjectCandidate, validatePositionScaleTimelineDOMMapping, waitForPositionScaleCommittedProject } from './video-ai-position-scale-diagnostics.mjs';
import { assertConnectedDeepSeekMetadata, assertPositionScaleApplyEntryReady, assertPositionScaleSyntheticResponse, classifyPositionScaleRequest, createPositionScaleAdapter, createPositionScaleSyntheticResponse, POSITION_SCALE_REDO_CONTROL_NAME, POSITION_SCALE_UNDO_CONTROL_NAME, readTimelineEditorProjectFromCurrentReactTree, resolvePositionScalePlaywright } from './video-ai-position-scale-browser-adapter.mjs';

const originalFetch=globalThis.fetch;
let offlineNetworkAttempts=0;
globalThis.fetch=async()=>{
  offlineNetworkAttempts++;
  throw new Error('OFFLINE_NETWORK_BLOCKED');
};
test.after(()=>{
  globalThis.fetch=originalFetch;
  assert.equal(offlineNetworkAttempts,0,'offline position-scale harness tests attempted network access');
});

test('Playwright module resolution uses portable Node resolution without launching a browser',async()=>{
  const playwright={chromium:{launch(){assert.fail('portable resolver must not launch a browser');}}};
  const loaded=[];
  assert.equal(await resolvePositionScalePlaywright({}, {playwright}),playwright);
  assert.equal(await resolvePositionScalePlaywright({}, {importModule:async specifier=>{loaded.push(specifier);return playwright;}}),playwright);
  assert.deepEqual(loaded,['playwright']);
  loaded.length=0;
  assert.equal(await resolvePositionScalePlaywright({MEDCLIP_PLAYWRIGHT_MODULE:'playwright-runtime'},
    {importModule:async specifier=>{loaded.push(specifier);return playwright;}}),playwright);
  assert.deepEqual(loaded,['playwright']);
  loaded.length=0;
  const missingModule=Object.assign(new Error('module unavailable'),{code:'ERR_MODULE_NOT_FOUND'});
  assert.equal(await resolvePositionScalePlaywright({MEDCLIP_PLAYWRIGHT_MODULE:'playwright-runtime'},
    {importModule:async specifier=>{loaded.push(specifier);if(specifier==='playwright')throw missingModule;return playwright;}}),playwright);
  assert.deepEqual(loaded,['playwright','playwright-runtime']);
});

function projects() {
  const before=structuredClone(setup().project);
  for(const clip of eligibleClips(before)) clip.transform={x:0,y:0,scale:1,crop:0.1,fit:'cover'};
  const ids=eligibleClips(before).map(c=>c.id);
  const after=structuredClone(before); const target=eligibleClips(after)[2];
  target.transform={...target.transform,x:25,y:-25,scale:0.8};
  return {before,after,ids,targetId:ids[2]};
}

test('position-scale AI history matrix matches the visible TimelineEditor snapshot semantics',()=>{
  const {before,ids,targetId}=projects();
  const actionData={summary:'position',actions:[createPositionScaleAction(targetId)],warnings:[],unsupported:[]};
  const context=project=>({project,ownedAssetIds:new Set(project.assets.map(asset=>asset.id)),
    audioSourceDurationMs:project.audioSelection.sourceDurationMs});
  const selectedClipId=targetId;
  const changed=applyAIEditingPlan(actionData,context(before)).project;
  assert.notEqual(changed,before,'non-noop is detected by project identity');

  // EditorStudio holds the one pending pre-edit snapshot while TimelineEditor is closed.
  let pendingUndo=structuredClone(before);
  assert.deepEqual(transformOf(eligibleClips(pendingUndo)[2]),{x:0,y:0,scale:1});
  let undo=recordProjectUndoSnapshot([],pendingUndo);
  let redo=[];
  pendingUndo=null;
  assert.equal(undo.length,1,'mount transfers exactly one pending AI snapshot');
  assert.equal(pendingUndo,null,'one-shot bridge is consumed after mount');
  assert.deepEqual(transformOf(eligibleClips(changed)[2]),{x:25,y:-25,scale:0.8});
  assert.deepEqual(eligibleClips(changed).map(clip=>clip.id),ids);
  assert.equal(selectedClipId,targetId,'selection is independent of project history');
  assertPositionScalePreserved(before,changed,targetId,{x:25,y:-25,scale:0.8});

  let current=changed;
  const previous=undo.pop();
  assert.ok(previous);
  redo.push(structuredClone(current));
  current=previous;
  assert.deepEqual(transformOf(eligibleClips(current)[2]),{x:0,y:0,scale:1});
  assert.equal(redo.length,1);
  const next=redo.pop();
  assert.ok(next);
  undo=recordProjectUndoSnapshot(undo,current);
  current=next;
  assert.deepEqual(transformOf(eligibleClips(current)[2]),{x:25,y:-25,scale:0.8});

  // Undo followed by a distinct edit records the current state and clears redo.
  redo.push(structuredClone(current));
  current=undo.pop();
  const replacementAction={...actionData,actions:[{
    ...createPositionScaleAction(targetId),x:10,y:5,scale:1.1,
  }]};
  undo=recordProjectUndoSnapshot(undo,current);
  redo=[];
  current=applyAIEditingPlan(replacementAction,context(current)).project;
  assert.equal(redo.length,0);
  assert.deepEqual(transformOf(eligibleClips(current)[2]),{x:10,y:5,scale:1.1});

  const noOp=applyAIEditingPlan({summary:'noop',actions:[{
    ...createPositionScaleAction(targetId),x:0,y:0,scale:1,
  }],warnings:[],unsupported:[]},context(before)).project;
  assert.equal(noOp,before,'no-op returns the original project and creates no pending history boundary');
  const noOpUndo=noOp===before ? [] : recordProjectUndoSnapshot([],before);
  assert.equal(noOpUndo.length,0);
});

test('OLD D15-R15 history repro isolates the mistyped Undo locator and the fixed exact control name',()=>{
  const renderedUndo='\u21b6 \u64a4\u9500';
  const oldR15Pattern='\u64a7\u9500';
  assert.equal(renderedUndo.includes(oldR15Pattern),false,'old U+64A7 locator cannot find the product Undo control');
  assert.equal(POSITION_SCALE_UNDO_CONTROL_NAME,renderedUndo);
  assert.equal(POSITION_SCALE_REDO_CONTROL_NAME,'\u21b7 \u91cd\u505a');
  const adapter=readFileSync(new URL('./video-ai-position-scale-browser-adapter.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(adapter,/\\u64a7\\u9500/);
  assert.match(adapter,/name:POSITION_SCALE_UNDO_CONTROL_NAME,exact:true/);
  assert.doesNotMatch(adapter,/isEnabled\(\)\.catch\(\(\)=>false\)/);
});

test('OLD D15-R17-R1 Undo result repro isolates the first property grid from the transform grid',()=>{
  const {before,after,ids,targetId}=projects();
  const history=[structuredClone(before)],future=[];
  let current=after;
  const previous=history.pop();
  future.push(structuredClone(current));
  current=previous;
  assert.deepEqual(transformOf(eligibleClips(current)[2]),{x:0,y:0,scale:1},
    'source-valid Undo restores trusted C before any observer runs');
  assert.deepEqual(eligibleClips(current).map(clip=>clip.id),ids);
  assert.deepEqual(transformOf(eligibleClips(future[0])[2]),{x:25,y:-25,scale:0.8});

  const oldFirstGridObservation={selectedCount:1,selectedAssetId:eligibleClips(current)[2].assetId,
    x:'4.00',y:'6.00',scale:'0.00'};
  assert.equal(inspectPositionScaleHistoryUI(oldFirstGridObservation,{x:0,y:0,scale:1},
    eligibleClips(current)[2].assetId).matches,false,
  'R17-R1 read the timing grid and therefore could never prove the valid Undo transform');
  const transformGridObservation={selectedCount:1,selectedAssetId:eligibleClips(current)[2].assetId,
    x:'0',y:'0',scale:'1'};
  assert.equal(inspectPositionScaleHistoryUI(transformGridObservation,{x:0,y:0,scale:1},
    eligibleClips(current)[2].assetId).matches,true);

  const adapter=readFileSync(new URL('./video-ai-position-scale-browser-adapter.mjs',import.meta.url),'utf8');
  const historyObserver=adapter.slice(adapter.indexOf('async observeHistoryTransform'),adapter.indexOf('async undo'));
  assert.match(historyObserver,/const transformGrid=grids\.find\(grid=>/);
  assert.doesNotMatch(historyObserver,/querySelector\('\.editor-properties \.property-grid'\)\?\.querySelectorAll/);
  for(const stage of ['UNDO_PROJECT_TRANSITION','UNDO_C_RESELECTION','UNDO_UI_OBSERVATION',
    'UNDO_PREVIEW_BINDING','UNDO_PREVIEW_OBSERVATION','REDO_PROJECT_TRANSITION','REDO_C_RESELECTION',
    'REDO_UI_OBSERVATION','REDO_PREVIEW_BINDING','REDO_PREVIEW_OBSERVATION'])
    assert.ok(POSITION_SCALE_SUBSTAGES.includes(stage));
});
const expectedAction=targetId=>({...POSITION_SCALE_ACTION,targetId});
const metadataEnv={NEXT_PUBLIC_SUPABASE_URL:'https://safeproject.supabase.co',SUPABASE_ACCESS_TOKEN:'TEST_PAT',
  NEXT_PUBLIC_SUPABASE_ANON_KEY:'safe-anon-key',MEDCLIP_TEST_USER_A_EMAIL:'test-user@example.invalid',MEDCLIP_TEST_USER_A_PASSWORD:'test-password-never-print',
  MEDCLIP_REORDER_VIDEO_A:'a.mp4',MEDCLIP_REORDER_VIDEO_B:'b.mp4',MEDCLIP_REORDER_VIDEO_C:'c.mp4',MEDCLIP_REORDER_AUDIO:'audio.wav'};
const metadataFetcher=(body,status=200)=>async(url,init)=>({ok:status>=200&&status<300,status,json:async()=>body,url,init});

test('canonical top-right 80 percent fixture and valid A/B/C project pass',()=>{
  assert.equal(typeof createPositionScaleAdapter,'function');
  const {before,ids,targetId}=projects();
  assertFixtureProject(before,ids,before.assets.map(a=>a.id));
  assertPositionScaleAction(expectedAction(targetId),targetId);
  assert.equal(EXPECTED_POSITION_SCALE.scale,0.8);
  assert.equal(POSITION_SCALE_FIXTURE_REASON.includes('Provider-free'),true);
});
test('canonical position-scale action contract requires exact keys, trusted string target, and numeric values',()=>{
  const {targetId}=projects();
  const action=createPositionScaleAction(targetId);
  assert.deepEqual(Object.keys(action).sort(),[...POSITION_SCALE_ACTION_KEYS].sort());
  assert.deepEqual(action,{type:'SET_CLIP_POSITION_SCALE',targetId,assetId:'',x:25,y:-25,scale:0.8,reason:POSITION_SCALE_FIXTURE_REASON});
  assert.equal(typeof action.targetId,'string');
  for(const key of ['x','y','scale']) assert.equal(typeof action[key],'number');
  assert.equal(action.assetId,'');
  assert.equal(typeof action.reason,'string');assert.ok(action.reason.trim());
});
test('canonical action assertion rejects missing or wrong target, missing reason, wrong values, and extra fields',()=>{
  const {targetId}=projects(),action=expectedAction(targetId);
  for(const invalid of [
    Object.fromEntries(Object.entries(action).filter(([key])=>key!=='targetId')),
    {...action,targetId:'untrusted-target'},
    {...action,assetId:'asset-id'},
    {...action,x:'25'},
    {...action,y:'-25'},
    {...action,scale:'0.8'},
    Object.fromEntries(Object.entries(action).filter(([key])=>key!=='reason')),
    {...action,diagnosticOnly:true},
  ]) assert.throws(()=>assertPositionScaleAction(invalid,targetId));
  assert.throws(()=>createPositionScaleAction(undefined));
  assert.throws(()=>createPositionScaleAction(''));
});
test('action assertion rejects plan and full Edge envelope layers',()=>{
  const {targetId}=projects(),response=createPositionScaleSyntheticResponse(targetId);
  assert.throws(()=>assertPositionScaleAction(response.result.data,targetId));
  assert.throws(()=>assertPositionScaleAction(response,targetId));
  assert.deepEqual(Object.keys(response.result.data).sort(),['actions','summary','unsupported','warnings']);
  assert.deepEqual(Object.keys(response.result.data.actions[0]).sort(),[...POSITION_SCALE_ACTION_KEYS].sort());
});
test('OLD D15-R1 fixture-shape failure reproduces when baseline normalization adds an own undefined field',async()=>{
  const {before,ids}=projects();
  before.captions=[{id:'fixture-caption',text:'Fixture',startMs:0,endMs:1000}];
  const stale=structuredClone(before);stale.captions[0].confidence=undefined;
  const adapter={
    provenance:async()=>({pid:1,cwd:'local',gitHead:'head',hashes:{runner:'a',browserAdapter:'b',diagnostics:'c'}}),
    remoteMetadata:async()=>({version:70,status:'ACTIVE'}),armProviderGuard:async()=>{},
    authenticate:async()=>({}),openEditor:async()=>({httpStatus:200}),
    fixture:async()=>({project:before,clipIds:ids,expectedClipIds:ids,assetIds:before.assets.map(a=>a.id),
      contextOrder:['A','B','C'],contextTransform:{x:0,y:0,scale:1}}),
    captureProject:async()=>stale,applyCanonicalAction:async()=>assert.fail('stale baseline must stop before submission'),close:async()=>{},
  };
  await assert.rejects(runPositionScalePreflight(['--mode=preflight'],{},async()=>adapter),error=>{
    assert.equal(error.substage,'POSITION_SCALE_FIXTURE_BASELINE');
    return true;
  });
});
test('correct fixture baseline passes shape and snapshot gates before the next adapter stage',async()=>{
  const {before,ids}=projects();
  const adapter={
    provenance:async()=>({pid:1,cwd:'local',gitHead:'head',hashes:{runner:'a',browserAdapter:'b',diagnostics:'c'}}),
    remoteMetadata:async()=>({version:70,status:'ACTIVE'}),armProviderGuard:async()=>{},
    authenticate:async()=>({}),openEditor:async()=>({httpStatus:200}),
    fixture:async()=>({project:before,clipIds:ids,expectedClipIds:ids,assetIds:before.assets.map(a=>a.id),
      contextOrder:['A','B','C'],contextTransform:{x:0,y:0,scale:1}}),
    captureProject:async()=>before,applyCanonicalAction:async(action)=>{
      assertPositionScaleAction(action,ids[2]);throw new PositionScaleGateError('POSITION_SCALE_PROVIDER_SELECT');
    },close:async()=>{},
  };
  await assert.rejects(runPositionScalePreflight(['--mode=preflight'],{},async()=>adapter),error=>{
    assert.equal(error.substage,'POSITION_SCALE_PROVIDER_SELECT');
    return true;
  });
});
test('browser adapter uses one committed fixture snapshot for baseline capture and runner fixture',()=>{
  const adapter=readFileSync(new URL('./video-ai-position-scale-browser-adapter.mjs',import.meta.url),'utf8');
  assert.match(adapter,/baselineProject=state\.project/);
  assert.match(adapter,/positionScaleFixture=\{project:baselineProject,clipIds:clips\.map\(c=>c\.id\),expectedClipIds:clips\.map\(c=>c\.id\)/);
  assert.match(adapter,/return positionScaleFixture/);
  assert.match(adapter,/resolvePositionScaleTimelineMapping\(positionScaleFixture\.project,positionScaleFixture\.expectedClipIds,targetId/);
  assert.match(adapter,/if\(!appliedProject\) return baselineProject/);
});
for(const [name,change] of [
  ['wrong target',a=>({...a,targetId:'wrong-id'})],['wrong x',a=>({...a,x:24})],
  ['wrong y',a=>({...a,y:-24})],['wrong scale',a=>({...a,scale:0.81})],
]) test(`canonical action rejects ${name}`,()=>{
  const {targetId}=projects(); assert.throws(()=>assertPositionScaleAction(change(expectedAction(targetId)),targetId));
});
test('preservation verifier rejects source, range, ordering, binding, audio and duration drift',()=>{
  const {before,after,targetId}=projects();
  assert.doesNotThrow(()=>assertPositionScalePreserved(before,after,targetId,{x:25,y:-25,scale:0.8}));
  for(const mutate of [p=>eligibleClips(p)[2].sourceInMs++,p=>eligibleClips(p)[2].timelineEndMs++,
    p=>{const c=eligibleClips(p);[c[0].timelineStartMs,c[2].timelineStartMs]=[c[2].timelineStartMs,c[0].timelineStartMs]},
    p=>eligibleClips(p)[2].assetId='different',p=>p.tracks.find(t=>t.type==='audio').muted=true,
    p=>p.durationMs++]) {
    const drift=structuredClone(after);mutate(drift);assert.throws(()=>assertPositionScalePreserved(before,drift,targetId,{x:25,y:-25,scale:0.8}));
  }
});
test('undo and redo verifiers reject transform drift',()=>{
  const {before,after,targetId}=projects();
  assert.doesNotThrow(()=>assertHistoryState(before,before,targetId,{x:0,y:0,scale:1}));
  assert.throws(()=>assertHistoryState(after,before,targetId,{x:0,y:0,scale:1}));
  assert.doesNotThrow(()=>assertHistoryState(after,before,targetId,{x:25,y:-25,scale:0.8}));
  const drift=structuredClone(after);eligibleClips(drift)[2].transform.x=24;
  assert.throws(()=>assertHistoryState(drift,before,targetId,{x:25,y:-25,scale:0.8}));
});
test('provider count guard rejects every nonzero provider counter',()=>{
  assert.doesNotThrow(()=>assertProviderCounts({remote:0,deepseek:0,kimi:0,doubao:0,tokenhub:0}));
  for(const key of ['remote','deepseek','kimi','doubao','tokenhub']) assert.throws(()=>assertProviderCounts({[key]:1}));
});
test('safe diagnostics allow fixed position stages and never leak IDs or credentials',()=>{
  for(const stage of ['POSITION_SCALE_ACTION_FIXTURE_SHAPE','POSITION_SCALE_FIXTURE_BASELINE','POSITION_SCALE_ACTION_TARGET','POSITION_SCALE_ACTION_PARSE',
    'POSITION_SCALE_ACTION_VALIDATE','POSITION_SCALE_ACTION_APPLY','POSITION_SCALE_ACTION_HISTORY','POSITION_SCALE_ACTION_PERSIST',
    'POSITION_SCALE_AUTH','POSITION_SCALE_PROVIDER_METADATA','POSITION_SCALE_PROVIDER_SELECT','POSITION_SCALE_REQUIREMENT_INPUT',
    'POSITION_SCALE_GENERATION_INTERCEPT','POSITION_SCALE_RESPONSE_ENVELOPE','POSITION_SCALE_RESPONSE_EXTRACT'])
    assert.ok(POSITION_SCALE_SUBSTAGES.includes(stage));
  for(const stage of ['POSITION_SCALE_RESPONSE_INTERCEPT','POSITION_SCALE_RESPONSE_CONSUMED','POSITION_SCALE_PLAN_REJECTED_BEFORE_APPLY',
    'POSITION_SCALE_PLAN_ACCEPTED','POSITION_SCALE_TARGET_RESOLVED','POSITION_SCALE_PRODUCT_APPLY',
    'POSITION_SCALE_RESPONSE_OR_PRODUCT_ERROR','POSITION_SCALE_HISTORY','PREVIEW_TARGET_BINDING','PREVIEW_ELEMENT',
    'PREVIEW_TRANSFORM_PRESENT','PREVIEW_TRANSLATE_X','PREVIEW_TRANSLATE_Y','PREVIEW_SCALE']) assert.ok(POSITION_SCALE_SUBSTAGES.includes(stage));
  const hidden=['clip-secret-123','asset-secret-456','service_role=private','jwt.secret.token','raw project JSON'];
  const error=new PositionScaleGateError('POSITION_SCALE_ACTION_APPLY');
  for(const output of [JSON.stringify(error),String(error),formatPositionScaleFailure(error),error.stack])
    for(const secret of hidden) assert.ok(!output.includes(secret));
  assert.doesNotMatch(formatPositionScaleFailure(new Error(hidden.join('|'))),/clip-secret|asset-secret|service_role|jwt\.secret|raw project/);
  const previewFailure=new PositionScaleGateError('PREVIEW_TRANSLATE_X',undefined,{x:0,y:-25,scale:0.8,mediaUrl:'never-print'});
  const previewOutput=formatPositionScaleFailure(previewFailure);
  assert.match(previewOutput,/OBSERVED PREVIEW X = 0/);assert.match(previewOutput,/OBSERVED PREVIEW Y = -25/);
  assert.match(previewOutput,/OBSERVED PREVIEW SCALE = 0.8/);assert.doesNotMatch(previewOutput,/mediaUrl|never-print/);
});

test('D15-R3 stale-stage failure is reproduced and fixed post-plan boundaries report the failing operation',async()=>{
  let oldStage='POSITION_SCALE_PLAN_ACCEPTED';
  const oldError=(()=>{try{throw new Error('selection failed');}catch{return new PositionScaleGateError(oldStage);}})();
  assert.equal(oldError.substage,'POSITION_SCALE_PLAN_ACCEPTED');

  const expectedStages=['POSITION_SCALE_TARGET_CONFIRMATION','POSITION_SCALE_TARGET_CONFIRMED','POSITION_SCALE_TARGET_RESOLVED',
    'POSITION_SCALE_UI_SELECTION','POSITION_SCALE_UI_OBSERVATION','POSITION_SCALE_PREVIEW_OBSERVATION','POSITION_SCALE_PRODUCT_APPLY'];
  const stages=[];
  await runPositionScalePostPlanFlow({reportStage:stage=>stages.push(stage),
    confirmTarget:async()=>{},selectTarget:async()=>{},observeUI:async()=>({matches:true}),
    observePreview:async()=>({matches:true}),observeFiber:async()=>{throw new Error('diagnostic unavailable');}});
  assert.deepEqual(stages,expectedStages);

  for(const [operation,expected] of [
    ['confirmTarget','POSITION_SCALE_TARGET_CONFIRMATION'],['selectTarget','POSITION_SCALE_UI_SELECTION'],
    ['observeUI','POSITION_SCALE_UI_OBSERVATION'],['observePreview','POSITION_SCALE_PREVIEW_OBSERVATION']]) {
    let stage='POSITION_SCALE_PLAN_ACCEPTED';
    await assert.rejects(runPositionScalePostPlanFlow({reportStage:value=>{stage=value;},
      confirmTarget:async()=>{if(operation==='confirmTarget') throw Error('safe fixture failure');},
      selectTarget:async()=>{if(operation==='selectTarget') throw Error('safe fixture failure');},
      observeUI:async()=>{if(operation==='observeUI') throw Error('safe fixture failure');return {matches:true};},
      observePreview:async()=>{if(operation==='observePreview') throw Error('safe fixture failure');return {matches:true};}}),()=>{
        const wrapped=new PositionScaleGateError(stage);
        assert.equal(wrapped.substage,expected);
        return true;
      });
  }
});

test('post-plan flow explicitly selects C before UI, then checks preview, and keeps each failure stage precise',async()=>{
  const calls=[],stages=[];
  await runPositionScalePostPlanFlow({reportStage:stage=>stages.push(stage),
    confirmTarget:async()=>calls.push('trusted-C'),selectTarget:async()=>calls.push('real-UI-select-C'),
    observeUI:async()=>{calls.push('read-xyz-controls');return {matches:true};},
    observePreview:async()=>{calls.push('read-editor-preview');return {matches:true};},
    observeFiber:async()=>{calls.push('fiber-diagnostic');return 'STALE';}});
  assert.deepEqual(calls,['trusted-C','real-UI-select-C','read-xyz-controls','read-editor-preview','fiber-diagnostic']);
  assert.ok(calls.indexOf('real-UI-select-C')<calls.indexOf('read-xyz-controls'));
  assert.ok(calls.indexOf('read-xyz-controls')<calls.indexOf('read-editor-preview'));
  assert.equal(stages.at(-1),'POSITION_SCALE_PRODUCT_APPLY');
  await assert.rejects(runPositionScalePostPlanFlow({confirmTarget:async()=>{},selectTarget:async()=>{},
    observeUI:async()=>({matches:false}),observePreview:async()=>({matches:true})}),
    error=>error.substage==='POSITION_SCALE_PRODUCT_APPLY_UI');
  await assert.rejects(runPositionScalePostPlanFlow({confirmTarget:async()=>{},selectTarget:async()=>{},
    observeUI:async()=>({matches:true}),observePreview:async()=>({matches:false})}),
    error=>error.substage==='POSITION_SCALE_APPLY_OBSERVER_CONFLICT');
  await assert.rejects(runPositionScalePostPlanFlow({confirmTarget:async()=>{},selectTarget:async()=>{},
    observeUI:async()=>({matches:true}),observePreview:async()=>({matches:false,substage:'PREVIEW_TRANSLATE_X',actual:{x:0,y:-25,scale:0.8}})}),
    error=>error.substage==='PREVIEW_TRANSLATE_X' && error.observedPreview.x===0 && error.observedPreview.y===-25);
});

test('R5 visible-after-click assertion does not prove selection and corrected observer requires selected C plus bound controls',()=>{
  const oldR5Acceptance=visible=>visible;
  assert.equal(oldR5Acceptance(true),true,'R5 accepted an already-visible locator without proving selection');
  const expected={domIndex:1,clipCount:3,assetId:'trusted-asset-C'};
  assert.deepEqual(inspectPositionScaleTimelineSelection({timelineVisible:true,clipCount:3,selectedIndices:[],
    propertyPaneKind:'未选择',transformGridVisible:false,selectedAssetId:undefined},expected),{matches:false});
  assert.deepEqual(inspectPositionScaleTimelineSelection({timelineVisible:true,clipCount:3,selectedIndices:[1],
    propertyPaneKind:'素材片段',transformGridVisible:true,selectedAssetId:'trusted-asset-C'},expected),{matches:true});
});

test('trusted C timeline mapping mirrors TimelineEditor track DOM order and rejects stale or duplicate renderings',()=>{
  const track=(id,type,clips)=>({id,type,clips:clips.map(clip=>({...clip,trackId:id}))});
  const clip=(id,timelineStartMs,assetId=id)=>({id,assetId,timelineStartMs,timelineEndMs:timelineStartMs+1000});
  const project={tracks:[
    track('video-0','video',[clip('A',0),clip('C',2000)]),
    track('audio-0','audio',[clip('audio',0)]),
    track('broll-0','broll',[clip('B',1000)]),
  ],captions:[{id:'caption',startMs:0,endMs:500}]};
  const chronological=['A','B','C'];
  // TimelineEditor renders video clips, then b-roll clips; audio and captions use other DOM nodes.
  assert.equal(resolvePositionScaleTimelineDomIndex(project,chronological,'C',3),1);
  assert.notEqual(resolvePositionScaleTimelineDomIndex(project,chronological,'C',3),2,
    'trusted C must not be treated as the third raw DOM clip when tracks are grouped');
  assert.equal(resolvePositionScaleTimelineDomIndex(project,chronological,'B',3),null,'wrong ordinal target rejected');
  assert.equal(resolvePositionScaleTimelineDomIndex(project,chronological,'C',4),null,'duplicate/extra rendered clip rejected');
  assert.equal(resolvePositionScaleTimelineDomIndex(project,['A','C','B'],'C',3),null,'stale chronological order rejected');
  assert.equal(resolvePositionScaleTimelineDomIndex(project,chronological,'C',2),null,'missing rendered clip rejected');
});

test('R8 reproduces the old generic R7 DOM-count mapping failure and classifies it precisely',()=>{
  const track=(id,type,clips)=>({id,type,clips:clips.map(clip=>({...clip,trackId:id}))});
  const clip=(id,timelineStartMs)=>({id,timelineStartMs});
  const project={tracks:[track('video-0','video',[clip('A',0),clip('C',2000)]),
    track('audio-0','audio',[clip('audio',0)]),track('broll-0','broll',[clip('B',1000)])]};
  const oldR7Result=resolvePositionScaleTimelineDomIndex(project,['A','B','C'],'C',4);
  assert.equal(oldR7Result,null,'R7 collapsed DOM-count mismatch to a null global index');
  const mapped=resolvePositionScaleTimelineMapping(project,['A','B','C'],'C');
  assert.deepEqual(mapped,{mapping:{trackKind:'video',renderedTrackOrdinal:0,localClipOrdinal:1,
    projectTrackOrdinal:0,localProjectTrackClipOrdinal:1}});
  assert.deepEqual(validatePositionScaleTimelineDOMMapping(mapped.mapping,{visualTrackContainerCount:2,
    trackClipCount:2,renderedClipCount:4,expectedRenderedClipCount:3}),
    {valid:false,substage:'UI_SELECTION_MAPPING_DOM_COUNT'});
});

test('track-local target mapping covers single-track local ordinals zero through two',()=>{
  const track={id:'video-0',type:'video',clips:[{id:'A',timelineStartMs:0},{id:'B',timelineStartMs:1000},{id:'C',timelineStartMs:2000}]};
  track.clips.forEach(clip=>{clip.trackId=track.id;});
  const project={tracks:[track,{id:'audio-0',type:'audio',clips:[]}]};
  for(const [index,id] of ['A','B','C'].entries()) {
    const result=resolvePositionScaleTimelineMapping(project,['A','B','C'],id);
    if(index===2) assert.equal(result.mapping.localClipOrdinal,2);
    else assert.equal(result.substage,'UI_SELECTION_MAPPING_PROJECT_TRACK_FIXTURE_ID','only trusted C is accepted as target');
  }
  assert.deepEqual(resolvePositionScaleTimelineMapping(project,['A','B','C'],'C').mapping,
    {trackKind:'video',renderedTrackOrdinal:0,localClipOrdinal:2,projectTrackOrdinal:0,localProjectTrackClipOrdinal:2});
});

test('track-local mapping mirrors grouped video and b-roll JSX when chronology differs from DOM order',()=>{
  const track=(id,type,clips)=>({id,type,clips:clips.map(clip=>({...clip,trackId:id}))});
  const project={tracks:[track('video-0','video',[{id:'A',timelineStartMs:0},{id:'C',timelineStartMs:2000}]),
    track('audio-0','audio',[{id:'audio',timelineStartMs:0}]),track('broll-0','broll',[{id:'B',timelineStartMs:1000}])],
    captions:[{id:'caption',startMs:0,endMs:100}]};
  const result=resolvePositionScaleTimelineMapping(project,['A','B','C'],'C');
  assert.deepEqual(result.mapping,{trackKind:'video',renderedTrackOrdinal:0,localClipOrdinal:1,
    projectTrackOrdinal:0,localProjectTrackClipOrdinal:1});
  const brollTarget=resolvePositionScaleTimelineMapping(project,['A','B','C'],'B');
  assert.equal(brollTarget.substage,'UI_SELECTION_MAPPING_PROJECT_TRACK_FIXTURE_ID','target must remain trusted chronological C');
  const projectWithCInBroll={tracks:[track('video-0','video',[{id:'A',timelineStartMs:0},{id:'B',timelineStartMs:1000}]),
    track('broll-0','broll',[{id:'C',timelineStartMs:2000}])]};
  assert.deepEqual(resolvePositionScaleTimelineMapping(projectWithCInBroll,['A','B','C'],'C').mapping,
    {trackKind:'broll',renderedTrackOrdinal:1,localClipOrdinal:0,projectTrackOrdinal:1,localProjectTrackClipOrdinal:0});
});

test('track-local mapper handles empty visual groups, audio/captions, and mapping failure categories',()=>{
  const track=(id,type,clips)=>({id,type,clips:clips.map(clip=>({...clip,trackId:id}))});
  const project={tracks:[track('video-0','video',[]),track('audio-0','audio',[{id:'audio',timelineStartMs:0}]),
    track('broll-0','broll',[{id:'A',timelineStartMs:0},{id:'B',timelineStartMs:1000},{id:'C',timelineStartMs:2000}])],
    captions:[{id:'caption',startMs:0,endMs:500}]};
  const mapping=resolvePositionScaleTimelineMapping(project,['A','B','C'],'C').mapping;
  assert.deepEqual(mapping,{trackKind:'broll',renderedTrackOrdinal:1,localClipOrdinal:2,
    projectTrackOrdinal:2,localProjectTrackClipOrdinal:2});
  assert.deepEqual(validatePositionScaleTimelineDOMMapping(mapping,{visualTrackContainerCount:2,
    trackClipCount:3,renderedClipCount:3,expectedRenderedClipCount:3}),{valid:true,substage:null});
  assert.equal(validatePositionScaleTimelineDOMMapping(mapping,{visualTrackContainerCount:1,
    trackClipCount:3,renderedClipCount:3,expectedRenderedClipCount:3}).substage,'UI_SELECTION_MAPPING_TRACK_CONTAINER');
  assert.equal(validatePositionScaleTimelineDOMMapping(mapping,{visualTrackContainerCount:2,
    trackClipCount:2,renderedClipCount:3,expectedRenderedClipCount:3}).substage,'UI_SELECTION_MAPPING_LOCAL_INDEX');
  assert.equal(validatePositionScaleTimelineDOMMapping(mapping,{visualTrackContainerCount:2,
    trackClipCount:3,renderedClipCount:4,expectedRenderedClipCount:3}).substage,'UI_SELECTION_MAPPING_DOM_COUNT');
  assert.equal(resolvePositionScaleTimelineMapping(project,['A','B','C'],'missing').substage,
    'UI_SELECTION_MAPPING_PROJECT_TRACK_ZERO_MATCH');
});

test('project-track resolver distinguishes zero, multiple, unsupported-kind, and ownership-identity failures',()=>{
  const track=(id,type,clips)=>({id,type,clips:clips.map(clip=>({...clip,trackId:id}))});
  const visual=[{id:'A',timelineStartMs:0},{id:'B',timelineStartMs:1000},{id:'C',timelineStartMs:2000}];
  const valid={tracks:[track('video-0','video',visual)]};
  assert.equal(resolvePositionScaleTimelineMapping(valid,['A','B','C'],'missing').substage,
    'UI_SELECTION_MAPPING_PROJECT_TRACK_ZERO_MATCH');
  const duplicate={tracks:[track('video-0','video',visual),track('broll-0','broll',[{...visual[2]}])]};
  assert.equal(resolvePositionScaleTimelineMapping(duplicate,['A','B','C'],'C').substage,
    'UI_SELECTION_MAPPING_PROJECT_TRACK_MULTI_MATCH');
  const wrongKind={tracks:[track('video-0','video',[visual[0],visual[1]]),track('caption-0','captions',[visual[2]])]};
  assert.equal(resolvePositionScaleTimelineMapping(wrongKind,['A','B','C'],'C').substage,
    'UI_SELECTION_MAPPING_PROJECT_TRACK_KIND');
  const wrongOwner=structuredClone(valid);wrongOwner.tracks[0].clips[2].trackId='another-track';
  assert.equal(resolvePositionScaleTimelineMapping(wrongOwner,['A','B','C'],'C').substage,
    'UI_SELECTION_MAPPING_PROJECT_TRACK_TRACK_ID');
  assert.equal(resolvePositionScaleTimelineMapping(valid,['A','B','C'],'asset-C').substage,
    'UI_SELECTION_MAPPING_PROJECT_TRACK_ZERO_MATCH','assetId cannot stand in for clip.id');
  assert.deepEqual(resolvePositionScaleTimelineMapping(valid,['A','B','C'],'C').mapping,
    {trackKind:'video',renderedTrackOrdinal:0,localClipOrdinal:2,projectTrackOrdinal:0,localProjectTrackClipOrdinal:2});
});

test('R9 global uniqueness-guard mechanism repro uses a helper-shaped project; trusted C still resolves uniquely',()=>{
  const {before}=projects();
  const clips=eligibleClips(before);
  clips[1].id=clips[0].id;
  const ids=clips.map(clip=>clip.id),targetId=clips[2].id;
  const assetIds=clips.map(clip=>clip.assetId);
  assertFixtureProject(before,ids,assetIds);
  const oldR9UniqueAllClipsPredicate=new Set(clips.map(clip=>clip.id)).size===clips.length;
  assert.equal(oldR9UniqueAllClipsPredicate,false);
  const mapping=resolvePositionScaleTimelineMapping(before,ids,targetId);
  assert.deepEqual(mapping.mapping,{trackKind:'video',renderedTrackOrdinal:0,localClipOrdinal:2,
    projectTrackOrdinal:before.tracks.findIndex(track=>track.clips.some(clip=>clip.id===targetId)),
    localProjectTrackClipOrdinal:before.tracks.find(track=>track.clips.some(clip=>clip.id===targetId)).clips.findIndex(clip=>clip.id===targetId)});
  assert.equal(before.tracks.flatMap(track=>track.clips).filter(clip=>clip.id===targetId).length,1,
    'uniqueness remains strict for trusted C');
  const applied=applyAIEditingPlan({summary:'position',actions:[createPositionScaleAction(targetId)],warnings:[],unsupported:[]},
    {project:before,ownedAssetIds:new Set(before.assets.map(asset=>asset.id)),audioSourceDurationMs:before.audioSelection.sourceDurationMs});
  const appliedTarget=eligibleClips(applied.project)[2];
  assert.deepEqual({x:appliedTarget.transform.x,y:appliedTarget.transform.y,scale:appliedTarget.transform.scale},
    {x:25,y:-25,scale:0.8});
});

test('OLD D15-R11 identity repro: helper fixture nests expected IDs but mapper read them from the wrong fixture layer',()=>{
  const {before,ids,targetId}=projects();
  const ownedFixture={project:before,registeredAssets:[],preLiveContext:{expectedClipIds:ids}};
  assert.equal(ownedFixture.expectedClipIds,undefined);
  assert.equal(resolvePositionScaleTimelineMapping(ownedFixture.project,ownedFixture.expectedClipIds,targetId).substage,
    'UI_SELECTION_MAPPING_PROJECT_TRACK_FIXTURE_ID');
  const positionScaleFixture={project:before,clipIds:ids,expectedClipIds:ids,assetIds:[]};
  const resolved=resolvePositionScaleTimelineMapping(positionScaleFixture.project,positionScaleFixture.expectedClipIds,targetId,{
    fixtureTargetId:positionScaleFixture.clipIds[2],actionTargetId:targetId,baselineProject:before,
  });
  assert.equal(resolved.mapping.localClipOrdinal,2);
  const adapter=readFileSync(new URL('./video-ai-position-scale-browser-adapter.mjs',import.meta.url),'utf8');
  assert.match(adapter,/let [^;]*ownedFixture,positionScaleFixture/);
  assert.match(adapter,/positionScaleFixture=\{project:baselineProject,clipIds:clips\.map\(c=>c\.id\),expectedClipIds:clips\.map\(c=>c\.id\)/);
  assert.doesNotMatch(adapter,/resolvePositionScaleTimelineMapping\(fixture\.project,fixture\.expectedClipIds/);
});

test('trusted-C identity predicates report target, fixture, action, baseline, track, and post-plan failures separately',()=>{
  for(const stage of ['UI_SELECTION_MAPPING_PROJECT_TRACK_TARGET_ID','UI_SELECTION_MAPPING_PROJECT_TRACK_TRACK_ID',
    'UI_SELECTION_MAPPING_PROJECT_TRACK_FIXTURE_ID','UI_SELECTION_MAPPING_PROJECT_TRACK_ACTION_ID',
    'UI_SELECTION_MAPPING_PROJECT_TRACK_BASELINE_ID','UI_SELECTION_MAPPING_PROJECT_TRACK_POST_PLAN_ID'])
    assert.ok(POSITION_SCALE_SUBSTAGES.includes(stage));
  assert.equal(POSITION_SCALE_SUBSTAGES.includes('UI_SELECTION_MAPPING_PROJECT_TRACK_IDENTITY'),false);
  const track=(id,type,clips)=>({id,type,clips:clips.map(clip=>({...clip,trackId:id}))});
  const project={tracks:[track('video-0','video',[{id:'A',timelineStartMs:0},{id:'B',timelineStartMs:1000},{id:'C',timelineStartMs:2000}])]};
  const validIdentity={fixtureTargetId:'C',actionTargetId:'C',baselineProject:structuredClone(project)};
  assert.deepEqual(resolvePositionScaleTimelineMapping(project,['A','B','C'],'C',validIdentity).mapping.localClipOrdinal,2);
  assert.equal(resolvePositionScaleTimelineMapping(project,['A','B','C'],null).substage,
    'UI_SELECTION_MAPPING_PROJECT_TRACK_TARGET_ID');
  assert.equal(resolvePositionScaleTimelineMapping(project,['A','B','C'],'missing').substage,
    'UI_SELECTION_MAPPING_PROJECT_TRACK_ZERO_MATCH','clip.id must match trusted C');
  assert.equal(resolvePositionScaleTimelineMapping(project,['A','B','C'],'B').substage,
    'UI_SELECTION_MAPPING_PROJECT_TRACK_FIXTURE_ID','fixture C alias must remain C');
  assert.equal(resolvePositionScaleTimelineMapping(project,['A','B','C'],'C',{...validIdentity,fixtureTargetId:'B'}).substage,
    'UI_SELECTION_MAPPING_PROJECT_TRACK_FIXTURE_ID');
  assert.equal(resolvePositionScaleTimelineMapping(project,['A','B','C'],'C',{...validIdentity,actionTargetId:'B'}).substage,
    'UI_SELECTION_MAPPING_PROJECT_TRACK_ACTION_ID');
  const wrongTrackId=structuredClone(project);delete wrongTrackId.tracks[0].clips[2].trackId;
  assert.equal(resolvePositionScaleTimelineMapping(wrongTrackId,['A','B','C'],'C').substage,
    'UI_SELECTION_MAPPING_PROJECT_TRACK_TRACK_ID');
  const mismatchedTrackId=structuredClone(project);mismatchedTrackId.tracks[0].clips[2].trackId='other';
  assert.equal(resolvePositionScaleTimelineMapping(mismatchedTrackId,['A','B','C'],'C').substage,
    'UI_SELECTION_MAPPING_PROJECT_TRACK_TRACK_ID');
  const wrongBaseline=structuredClone(project);wrongBaseline.tracks[0].clips[2].id='baseline-drift';
  assert.equal(resolvePositionScaleTimelineMapping(project,['A','B','C'],'C',{...validIdentity,baselineProject:wrongBaseline}).substage,
    'UI_SELECTION_MAPPING_PROJECT_TRACK_BASELINE_ID');
  const postPlan=structuredClone(project);
  assert.deepEqual(comparePositionScaleTargetIdentity(project,postPlan,'C'),{matches:true,substage:null});
  postPlan.tracks[0].clips[2].trackId='other';
  assert.equal(comparePositionScaleTargetIdentity(project,postPlan,'C').substage,
    'UI_SELECTION_MAPPING_PROJECT_TRACK_POST_PLAN_ID');
  assert.equal(new Set(project.tracks[0].clips.map(clip=>clip.id)).size,3);
});

test('parser, clone, and position-scale apply preserve trusted C clip and track identity',()=>{
  const {before,ids,targetId}=projects();
  const parsed=parseEditorProject(JSON.stringify(before));
  const originalTrack=before.tracks.find(track=>track.clips.some(clip=>clip.id===targetId));
  const safeContext=JSON.parse(createSafeEditorAIContext(before,new Set(before.assets.map(asset=>asset.id)),before.audioSelection.sourceDurationMs));
  assert.equal(safeContext.clips[2].id,targetId);
  assert.equal(safeContext.clips[2].trackId,originalTrack.id);
  assert.equal(safeContext.clips[2].positionScaleEligible,true);
  const parsedClip=parsed.tracks.flatMap(track=>track.clips).find(clip=>clip.id===targetId);
  assert.equal(parsedClip.id,targetId);
  assert.equal(parsedClip.trackId,originalTrack.id);
  assert.deepEqual(comparePositionScaleTargetIdentity(before,parsed,targetId),{matches:true,substage:null});
  const missingTrackId=structuredClone(before);
  delete missingTrackId.tracks.find(track=>track.clips.some(clip=>clip.id===targetId)).clips.find(clip=>clip.id===targetId).trackId;
  const parsedMissingTrackId=parseEditorProject(JSON.stringify(missingTrackId));
  assert.equal(parsedMissingTrackId.tracks.flatMap(track=>track.clips).find(clip=>clip.id===targetId).trackId,undefined,
    'parser preserves omission; it does not synthesize ownership');
  const clone=structuredClone(parsed);
  assert.deepEqual(comparePositionScaleTargetIdentity(parsed,clone,targetId),{matches:true,substage:null});
  const applied=applyAIEditingPlan({summary:'position',actions:[createPositionScaleAction(targetId)],warnings:[],unsupported:[]},
    {project:parsed,ownedAssetIds:new Set(parsed.assets.map(asset=>asset.id)),audioSourceDurationMs:parsed.audioSelection.sourceDurationMs}).project;
  assert.deepEqual(comparePositionScaleTargetIdentity(parsed,applied,targetId),{matches:true,substage:null});
  assert.equal(eligibleClips(applied)[2].id,ids[2]);
});

test('project schema and position-scale validator define visual kinds and track ownership',()=>{
  const core=readFileSync(new URL('../app/editor-core.ts',import.meta.url),'utf8');
  const validator=readFileSync(new URL('../app/editor-ai-requirements.ts',import.meta.url),'utf8');
  assert.match(core,/export type TimelineTrackType = "audio" \| "video" \| "broll" \| "captions"/);
  assert.match(core,/export type TimelineTrack = \{[\s\S]*?type: TimelineTrackType;[\s\S]*?clips: TimelineClip\[\]/);
  assert.match(core,/export type TimelineClip = \{[\s\S]*?id: string;[\s\S]*?trackId: string;/);
  assert.match(core,/return \{\s*\.\.\.parsed,\s*schemaVersion: 2,\s*captions\s*\}/);
  assert.match(validator,/const matchingTracks = context\.project\.tracks\.filter\(\(track\) => track\.clips\.some\(\(candidate\) => candidate\.id === action\.targetId\)\)/);
  assert.match(validator,/clip\.trackId !== track\.id/);
});

test('shared fixture project track layout is retained and mapping survives project clones and position-scale transforms',()=>{
  const sharedFixtureSource=readFileSync(new URL('./video-ai-owned-asset-fixture.ts',import.meta.url),'utf8');
  assert.match(sharedFixtureSource,/const project = parseEditorProject\(serializedProject\)/);
  assert.match(sharedFixtureSource,/return \{\s*project,/);
  assert.match(sharedFixtureSource,/expectedTargetClipId: ordered\[2\]\.id/);
  const {before,ids,targetId}=projects();
  const beforeMapping=resolvePositionScaleTimelineMapping(before,ids,targetId);
  assert.ok(beforeMapping.mapping);
  assert.deepEqual(resolvePositionScaleTimelineMapping(structuredClone(before),ids,targetId),beforeMapping);
  const track=before.tracks.find(item=>item.clips.some(clip=>clip.id===targetId));
  const after=applyAIEditingPlan({summary:'position',actions:[createPositionScaleAction(targetId)],warnings:[],unsupported:[]},
    {project:before,ownedAssetIds:new Set(before.assets.map(asset=>asset.id)),audioSourceDurationMs:before.audioSelection.sourceDurationMs}).project;
  const afterTrack=after.tracks.find(item=>item.clips.some(clip=>clip.id===targetId));
  assert.equal(afterTrack.id,track.id);
  assert.deepEqual(resolvePositionScaleTimelineMapping(after,ids,targetId),beforeMapping);
});

test('TimelineEditor JSX renders two visual groups in video then b-roll order without sorting clip arrays',()=>{
  const source=readFileSync(new URL('../app/TimelineEditor.tsx',import.meta.url),'utf8');
  const start=source.indexOf('{(["video", "broll"] as const).map((trackType) => {');
  const end=source.indexOf('{captionChunks.map((chunk)',start);
  assert.ok(start>=0 && end>start);
  const render=source.slice(start,end);
  assert.match(render,/\.filter\(\(track\) => track\.type === trackType\)\s*\.flatMap\(\(track\) => track\.clips\)/);
  assert.match(render,/<div className="timeline-track" key=\{trackType\}>/);
  assert.match(render,/clips\.map\(\(clip\) => \(/);
  assert.match(render,/className=\{`timeline-clip/);
  assert.doesNotMatch(render,/\.sort\(/);
  assert.equal((render.match(/className=\{`timeline-clip/g)||[]).length,1,
    'each rendered clip originates from one map entry');
});

test('R7 UI selection emits distinct substages before each browser operation',()=>{
  const adapter=readFileSync(new URL('./video-ai-position-scale-browser-adapter.mjs',import.meta.url),'utf8');
  const start=adapter.indexOf('        selectTarget:async()=>{');
  const end=adapter.indexOf('        observeUI:async()=>{',start);
  assert.ok(start>=0 && end>start);
  const body=adapter.slice(start,end);
  const outer=[
    ['UI_SELECTION_DIALOG_READY','if(await closeDialog.isVisible())'],
    ['UI_SELECTION_EDITOR_READY','const continueButton=page.locator'],
    ['UI_SELECTION_TIMELINE_READY','timeline=page.locator'],
  ];
  let previous=-1;
  for(const [stage,operation] of outer) {
    assert.ok(POSITION_SCALE_SUBSTAGES.includes(stage),`${stage} is allowlisted`);
    const stageAt=body.indexOf(`reportStage('${stage}')`);
    const operationAt=body.indexOf(operation);
    assert.ok(stageAt>previous,`${stage} follows the previous selection boundary`);
    assert.ok(operationAt>stageAt,`${stage} is set before ${operation}`);
    previous=operationAt;
  }
  const helper=adapter.slice(adapter.indexOf('const selectTrustedTarget='),adapter.indexOf('const observeTrustedTargetPreview='));
  const helperOrder=[
    ["report('mapping');report('projectTrack');report('postPlanId')",'resolvePositionScaleTimelineMapping'],
    ["report('trackContainer')",'visualTrackGroups=timeline.locator'],
    ["report('localIndex')",'targetTrackContainer.locator'],
    ["report('domCount')","timeline.locator('.timeline-clip').count()"],
    ["report('click')",'await targetClipLocator.waitFor'],
    ["report('selectedState')",'await page.waitForFunction(({trackOrdinal,localClipOrdinal,clipCount})'],
    ["report('propertyGrid')",'await page.waitForFunction(({assetId})'],
  ];
  previous=-1;
  for(const [boundary,operation] of helperOrder) {
    const boundaryAt=helper.indexOf(boundary),operationAt=helper.indexOf(operation);
    assert.ok(boundaryAt>previous && operationAt>boundaryAt);
    previous=operationAt;
  }
  for(const stage of ['UI_SELECTION_MAPPING','UI_SELECTION_MAPPING_PROJECT_TRACK','UI_SELECTION_MAPPING_TRACK_CONTAINER',
    'UI_SELECTION_MAPPING_LOCAL_INDEX','UI_SELECTION_MAPPING_DOM_COUNT','UI_SELECTION_CLICK',
    'UI_SELECTION_SELECTED_STATE','UI_SELECTION_PROPERTY_GRID']) {
    assert.ok(POSITION_SCALE_SUBSTAGES.includes(stage));
    assert.ok(body.includes(stage));
  }
  assert.ok(helper.indexOf('if(!mappingResult.mapping) throw')<helper.indexOf("report('click')"));
  assert.ok(helper.indexOf('await targetClipLocator.click()')<helper.indexOf("report('selectedState')"));
});

test('failure evidence matrix assigns only directly evidenced safe substages',()=>{
  const delivered={interceptMatched:true,responseSent:true,envelopeValid:true,responseConsumed:true,
    planAccepted:true,targetResolved:true,projectMutated:true,historyAvailable:true,persistenceMatches:true};
  const cases=[
    [{},'POSITION_SCALE_RESPONSE_INTERCEPT'],
    [{interceptMatched:true,responseSent:false},'POSITION_SCALE_RESPONSE_INTERCEPT'],
    [{...delivered,envelopeValid:false},'POSITION_SCALE_RESPONSE_ENVELOPE'],
    [{...delivered,responseConsumed:false},'POSITION_SCALE_RESPONSE_CONSUMED'],
    [{...delivered,knownPlanRejection:true},'POSITION_SCALE_PLAN_REJECTED_BEFORE_APPLY'],
    [{...delivered,productError:true},'POSITION_SCALE_RESPONSE_OR_PRODUCT_ERROR'],
    [{...delivered,planAccepted:false},'POSITION_SCALE_RESPONSE_CONSUMED'],
    [{...delivered,projectMutated:false},'POSITION_SCALE_PRODUCT_APPLY'],
    [{...delivered,historyUndoControlFound:false},'HISTORY_UNDO_CONTROL_FOUND'],
    [{...delivered,historyUndoControlFound:true,historyUndoControlEnabled:false},'HISTORY_UNDO_CONTROL_ENABLED'],
    [{...delivered,historyAvailable:false},'POSITION_SCALE_HISTORY'],
    [{...delivered,persistenceChecked:true,persistenceMatches:false},'POSITION_SCALE_PERSISTENCE'],
    [{...delivered,providerGuardViolated:true},'POSITION_SCALE_PROVIDER_COUNT'],
  ];
  for(const [evidence,substage] of cases) assert.deepEqual(classifyPositionScaleEvidence(evidence),{result:'FAIL',substage});
  assert.deepEqual(classifyPositionScaleEvidence(delivered),{result:'PASS',substage:null});
});

test('D11 stale alternate snapshot is rejected until authoritative committed C transform appears',async()=>{
  const {before,ids,targetId}=projects();
  const actionData=createPositionScaleSyntheticResponse(targetId).result.data;
  const applied=applyAIEditingPlan(actionData,{project:before,ownedAssetIds:new Set(before.assets.map(asset=>asset.id)),
    audioSourceDurationMs:before.audioSelection.sourceDurationMs}).project;
  const target=eligibleClips(applied)[2];
  assert.deepEqual({x:target.transform.x,y:target.transform.y,scale:target.transform.scale},{x:25,y:-25,scale:0.8});
  assert.notStrictEqual(applied,before);
  assert.notStrictEqual(target,eligibleClips(before)[2]);

  // D11 searched both React fiber branches by clip IDs and could select the stale alternate.
  const oldD11Candidates=[before,applied];
  const oldD11Selection=oldD11Candidates.find(project=>eligibleClips(project).map(clip=>clip.id).join('|')===ids.join('|'));
  assert.strictEqual(oldD11Selection,before);
  assert.equal(inspectPositionScaleCommittedState(oldD11Selection,ids,targetId,{x:25,y:-25,scale:0.8}).transformMatches,false);

  let tick=0,reads=0;
  const committed=await waitForPositionScaleCommittedProject(async()=>++reads===1?before:applied,
    {expectedClipIds:ids,targetId,transform:{x:25,y:-25,scale:0.8}},
    {timeoutMs:50,pollIntervalMs:10,now:()=>tick,sleep:async ms=>{tick+=ms;}});
  assert.strictEqual(committed,applied);
  assert.equal(reads,2);
  assert.deepEqual(inspectPositionScaleCommittedState(committed,ids,targetId,{x:25,y:-25,scale:0.8}),
    {targetResolved:true,transformMatches:true});
});

test('committed-state wait rejects wrong C target and times out safely before commit',async()=>{
  const {before,ids,targetId}=projects();
  await assert.rejects(waitForPositionScaleCommittedProject(async()=>before,
    {expectedClipIds:ids,targetId:ids[1],transform:{x:25,y:-25,scale:0.8}},
    {timeoutMs:20,now:()=>0,sleep:async()=>{}}),error=>error.substage==='POSITION_SCALE_TARGET_RESOLVED');
  let tick=0;
  await assert.rejects(waitForPositionScaleCommittedProject(async()=>before,
    {expectedClipIds:ids,targetId,transform:{x:25,y:-25,scale:0.8}},
    {timeoutMs:20,pollIntervalMs:10,now:()=>tick,sleep:async ms=>{tick+=ms;}}),
    error=>error.substage==='POSITION_SCALE_PRODUCT_APPLY');
});

test('D13 generic project-shaped Fiber search reproduces the stale undo-project match',()=>{
  const {before,after,ids}=projects();
  const hookValues=[before,after];
  const oldGenericMatch=hookValues.find(value=>value?.schemaVersion===2
    && eligibleClips(value).map(clip=>clip.id).join('|')===ids.join('|'));
  assert.strictEqual(oldGenericMatch,before);
  assert.notDeepEqual(eligibleClips(oldGenericMatch)[2].transform,eligibleClips(after)[2].transform);
});

test('TimelineEditor candidate selection rejects wrong project owners and ambiguity',()=>{
  const {before,after,ids}=projects();
  const wrong={project:before,ownerProjectProp:false,hasProjectChangeCallback:true};
  const correct={project:after,ownerProjectProp:true,hasProjectChangeCallback:true};
  assert.strictEqual(selectTimelineEditorProjectCandidate([wrong,correct],ids),after);
  assert.equal(selectTimelineEditorProjectCandidate([correct,{...correct,project:structuredClone(after)}],ids),null);
  assert.equal(selectTimelineEditorProjectCandidate([{...correct,hasProjectChangeCallback:false}],ids),null);
});

test('selected-clip UI and source-authored preview transform are semantic product signals',()=>{
  const expected={x:25,y:-25,scale:0.8};
  assert.deepEqual(inspectPositionScaleUIValues({x:'25',y:'-25',scale:'0.8'},expected),
    {readable:true,matches:true,actual:expected});
  assert.equal(inspectPositionScaleUIValues({x:'0',y:'0',scale:'1'},expected).matches,false);
  assert.deepEqual(inspectPositionScalePreview({targetBindingMatches:true,elementCount:1,visible:true,
    mediaKind:'video',expectedMediaKind:'video',inlineTransform:'translate(25%, -25%) scale(0.8)'},expected),
    {readable:true,matches:true,actual:expected,substage:null});
  assert.equal(inspectPositionScalePreview({targetBindingMatches:true,elementCount:1,visible:true,
    mediaKind:'video',expectedMediaKind:'video',inlineTransform:'translate(0%, 0%) scale(1)'},expected).matches,false);
});

test('R13 preview observer repro: the hidden page preview is not the open TimelineEditor preview',()=>{
  const studio=readFileSync(new URL('../app/editor/EditorStudio.tsx',import.meta.url),'utf8');
  const timeline=readFileSync(new URL('../app/TimelineEditor.tsx',import.meta.url),'utf8');
  const adapter=readFileSync(new URL('./video-ai-position-scale-browser-adapter.mjs',import.meta.url),'utf8');
  assert.match(studio,/previewAsset\?\.preview && !editorOpen/);
  assert.match(studio,/\{editorProject && \([\s\S]*?<TimelineEditor[\s\S]*?visible=\{editorOpen\}/);
  assert.match(timeline,/hidden=\{!visible\}/);
  assert.match(timeline,/className=\{`editor-canvas editor-ratio-/);
  assert.match(timeline,/transform: clipPositionScaleCss\(activeClip\?\.transform/);
  assert.match(adapter,/\.editor-canvas > video, \.timeline-editor-shell \.editor-canvas > img/);
  const oldObservation=inspectPositionScalePreview({targetBindingMatches:false,elementCount:0,visible:false,
    mediaKind:null,inlineTransform:''},{x:25,y:-25,scale:0.8});
  assert.equal(oldObservation.substage,'PREVIEW_TARGET_BINDING');
  const corrected=inspectPositionScalePreview({targetBindingMatches:true,elementCount:1,visible:true,
    mediaKind:'video',expectedMediaKind:'video',inlineTransform:'translate(25%, -25%) scale(0.8)'},
  {x:25,y:-25,scale:0.8});
  assert.equal(corrected.matches,true);
});

test('preview semantic parser accepts equivalent numeric formatting and zero/negative/decimal transforms',()=>{
  const observe=(inlineTransform,expectedTransform,extra={})=>inspectPositionScalePreview({targetBindingMatches:true,
    elementCount:1,visible:true,mediaKind:'video',expectedMediaKind:'video',inlineTransform,...extra},expectedTransform);
  assert.deepEqual(observe('translate(25.0%, -2.5e1%) scale(8e-1)',{x:25,y:-25,scale:0.8}).actual,
    {x:25,y:-25,scale:0.8});
  assert.equal(observe('translate(0%, 0%) scale(1)',{x:0,y:0,scale:1}).matches,true);
  assert.equal(observe('translate(-12.5%, 7.25%) scale(1.125)',{x:-12.5,y:7.25,scale:1.125}).matches,true);
  assert.equal(observe('scale(0.8) translate(25%, -25%)',{x:25,y:-25,scale:0.8}).matches,false);
});

test('preview observer diagnoses target, element, transform, x, y and scale independently',()=>{
  const expected={x:25,y:-25,scale:0.8};
  const observe=(overrides={})=>inspectPositionScalePreview({targetBindingMatches:true,elementCount:1,visible:true,
    mediaKind:'video',expectedMediaKind:'video',inlineTransform:'translate(25%, -25%) scale(0.8)',...overrides},expected);
  assert.equal(observe({targetBindingMatches:false}).substage,'PREVIEW_TARGET_BINDING');
  assert.equal(observe({elementCount:0}).substage,'PREVIEW_ELEMENT');
  assert.equal(observe({elementCount:2}).substage,'PREVIEW_ELEMENT');
  assert.equal(observe({visible:false}).substage,'PREVIEW_ELEMENT');
  assert.equal(observe({mediaKind:'img'}).substage,'PREVIEW_ELEMENT');
  assert.equal(observe({inlineTransform:''}).substage,'PREVIEW_TRANSFORM_PRESENT');
  assert.equal(observe({inlineTransform:'none'}).substage,'PREVIEW_TRANSFORM_PRESENT');
  assert.equal(observe({inlineTransform:'translate(24%, -25%) scale(0.8)'}).substage,'PREVIEW_TRANSLATE_X');
  assert.equal(observe({inlineTransform:'translate(25%, -24%) scale(0.8)'}).substage,'PREVIEW_TRANSLATE_Y');
  assert.equal(observe({inlineTransform:'translate(25%, -25%) scale(0.9)'}).substage,'PREVIEW_SCALE');
});

test('video and image preview elements share base transform, animation composition preserves it',()=>{
  const expected={x:25,y:-25,scale:0.8},style='translate(25%, -25%) scale(0.8)';
  for(const mediaKind of ['video','img']) assert.equal(inspectPositionScalePreview({targetBindingMatches:true,
    elementCount:1,visible:true,mediaKind,expectedMediaKind:mediaKind,inlineTransform:style},expected).matches,true);
  const studio=readFileSync(new URL('../app/editor/EditorStudio.tsx',import.meta.url),'utf8');
  const timeline=readFileSync(new URL('../app/TimelineEditor.tsx',import.meta.url),'utf8');
  const css=readFileSync(new URL('../app/globals.css',import.meta.url),'utf8');
  const animation=css.match(/@keyframes preview-ken-burns\s*\{([\s\S]*?)\n\}/)?.[1]??'';
  assert.equal((studio.match(/transform: clipPositionScaleCss\(activeMatchSegment\?\.transform \?\? DEFAULT_TRANSFORM\)/g)??[]).length,2);
  assert.equal((timeline.match(/transform: clipPositionScaleCss\(activeClip\?\.transform/g)??[]).length,2);
  assert.match(animation,/translate:/);assert.match(animation,/scale:/);assert.doesNotMatch(animation,/transform:/);
});

test('multi-signal apply accepts UI plus preview and classifies Fiber disagreement',()=>{
  const base={commitCallbackInvoked:true,uiMatches:true,previewMatches:true,historyAvailable:true};
  assert.deepEqual(classifyPositionScaleApplySignals({...base,fiberReadable:true,fiberMatches:true}),
    {result:'PASS',classification:'PRODUCT_APPLY_CONFIRMED',substage:null});
  assert.deepEqual(classifyPositionScaleApplySignals({...base,fiberReadable:true,fiberMatches:false}),
    {result:'PASS',classification:'OBSERVER_CONFLICT',substage:null});
});

test('stale UI with persistence or history evidence is observer conflict, not an apply claim',()=>{
  const stale={commitCallbackInvoked:true,uiMatches:false,previewMatches:false,fiberMatches:false};
  for(const diagnostic of [{persistenceMatches:true},{historyAvailable:true},{fiberMatches:true},{previewMatches:true}])
    assert.deepEqual(classifyPositionScaleApplySignals({...stale,...diagnostic}),
      {result:'FAIL',classification:'OBSERVER_CONFLICT',substage:'POSITION_SCALE_PRODUCT_APPLY_OBSERVER_CONFLICT'});
});

test('missing live commit callback is classified as genuine product apply failure',()=>{
  assert.deepEqual(classifyPositionScaleApplySignals({commitCallbackInvoked:false,uiMatches:false,previewMatches:false}),
    {result:'FAIL',classification:'GENUINE_APPLY_FAILURE',substage:'POSITION_SCALE_PRODUCT_APPLY'});
});

test('product apply and history are observable before independent persistence verification',()=>{
  const applied={interceptMatched:true,responseSent:true,envelopeValid:true,responseConsumed:true,planAccepted:true,
    targetResolved:true,projectMutated:true,historyAvailable:true};
  assert.deepEqual(classifyPositionScaleEvidence(applied),{result:'PASS',substage:null});
  assert.deepEqual(classifyPositionScaleEvidence({...applied,historyAvailable:false}),
    {result:'FAIL',substage:'POSITION_SCALE_HISTORY'});
  assert.deepEqual(classifyPositionScaleEvidence({...applied,persistenceChecked:true,persistenceMatches:false}),
    {result:'FAIL',substage:'POSITION_SCALE_PERSISTENCE'});
});

test('old D9 summary timeout no longer claims action parse failure',()=>{
  const oldObservation={interceptMatched:true,responseSent:true,envelopeValid:true,responseConsumed:false,successSummaryVisible:false};
  const result=classifyPositionScaleEvidence(oldObservation);
  assert.deepEqual(result,{result:'FAIL',substage:'POSITION_SCALE_RESPONSE_CONSUMED'});
  assert.notEqual(result.substage,'POSITION_SCALE_ACTION_PARSE');
  const adapter=readFileSync(new URL('./video-ai-position-scale-browser-adapter.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(adapter,/waitFor\(\{state:'visible',timeout:90_000\}\);\s*\}\s*catch\s*\{\s*throw new PositionScaleGateError\('POSITION_SCALE_ACTION_PARSE'\)/);
});

test('runtime success and failure boundaries use existing safe editor signals',()=>{
  const adapter=readFileSync(new URL('./video-ai-position-scale-browser-adapter.mjs',import.meta.url),'utf8');
  const studio=readFileSync(new URL('../app/editor/EditorStudio.tsx',import.meta.url),'utf8');
  assert.match(adapter,/reportStage\('POSITION_SCALE_RESPONSE_INTERCEPT'\)/);
  assert.match(adapter,/syntheticResponsesSent\+\+/);
  assert.match(adapter,/\.editor-ai-apply-summary/);
  assert.match(adapter,/\.editor-ai-dialog-error\[role="alert"\]/);
  assert.match(adapter,/classifyPositionScaleEvidence\(\{\.\.\.evidence,persistenceChecked:false\}\)/);
  assert.match(adapter,/readEditorState\(page\)/);
  assert.match(adapter,/readTimelineEditorProjectFromCurrentReactTree/);
  assert.match(adapter,/rootOf\(hostFiber\)[\s\S]*?stateNode\?\.current/);
  assert.match(adapter,/inspectPositionScaleUIValues\(uiValues,expectedTransform\)/);
  assert.match(adapter,/inspectPositionScalePreview\(previewValue,expectedTransform\)/);
  assert.match(adapter,/undoButton\.isEnabled\(\)/);
  assert.match(adapter,/HISTORY_UNDO_CONTROL_FOUND/);
  assert.match(adapter,/HISTORY_UNDO_CONTROL_ENABLED/);
  assert.match(adapter,/HISTORY_UNDO_RESULT/);
  assert.match(adapter,/POSITION_SCALE_UNDO_CONTROL_NAME='\\u21b6 \\u64a4\\u9500'/);
  assert.match(adapter,/HISTORY_REDO_CONTROL_FOUND/);
  assert.match(adapter,/HISTORY_REDO_CONTROL_ENABLED/);
  assert.match(adapter,/HISTORY_REDO_RESULT/);
  assert.match(adapter,/async observeHistoryTransform\(expected, direction, reportStage=/);
  assert.match(adapter,/const transformGrid=grids\.find\(grid=>/);
  assert.match(adapter,/inspectPositionScaleHistoryUI\(uiValues,expected,positionScaleFixture\.assetIds\[2\]\)/);
  const historyPath=adapter.slice(adapter.indexOf('async observeHistoryTransform'),adapter.indexOf('async providerCounts'));
  assert.match(historyPath,/reportStage\(projectStage\)[\s\S]*reportStage\(reselectionStage\)[\s\S]*reportStage\(uiStage\)[\s\S]*observeTrustedTargetPreview/);
  assert.match(historyPath,/reportStage\('UNDO_CLICK'\)[\s\S]*undoButton\.click\(\)[\s\S]*observeHistoryTransform/);
  assert.match(historyPath,/reportStage\('REDO_CLICK'\)[\s\S]*redoButton\.click\(\)[\s\S]*observeHistoryTransform/);
  assert.doesNotMatch(historyPath,/waitForTimeout|setTimeout|sleep\(/);
  assert.doesNotMatch(adapter,/waitForTimeout\(120\)/);
  assert.match(adapter,/assert\.deepEqual\(persisted,project\)/);
  const reader=adapter.slice(adapter.indexOf('export function readTimelineEditorProjectFromCurrentReactTree'),adapter.indexOf('export async function createPositionScaleAdapter'));
  assert.doesNotMatch(reader,/hooks\.find|schemaVersion===2[\s\S]*memoizedState/);
  assert.match(reader,/props\?\.project/);
  assert.match(reader,/typeof props\.onProjectChange!=='function'/);
  const applyPath=adapter.slice(adapter.indexOf('async applyCanonicalAction'),adapter.indexOf('async assertPreview'));
  assert.match(applyPath,/runPositionScalePostPlanFlow/);
  assert.match(applyPath,/fiberDiagnostic/);
  assert.doesNotMatch(applyPath,/localStorage\.getItem\(key=>/);
  assert.match(applyPath,/selectTrustedTarget\(reportStage,/);
  const selectionHelper=adapter.slice(adapter.indexOf('const selectTrustedTarget='),adapter.indexOf('const observeTrustedTargetPreview='));
  assert.match(selectionHelper,/resolvePositionScaleTimelineMapping\(positionScaleFixture\.project,positionScaleFixture\.expectedClipIds,targetId/);
  assert.match(selectionHelper,/\.timeline-track:not\(\.audio-track\):not\(\.caption-track\)/);
  assert.match(selectionHelper,/targetTrackContainer\.locator\('\.timeline-clip'\)\.nth\(targetMapping\.localClipOrdinal\)/);
  assert.match(selectionHelper,/selected\[0\]===target/);
  assert.match(selectionHelper,/assetSelect\?\.value===assetId/);
  assert.doesNotMatch(applyPath,/sort\(\(a,b\)=>a\.left-b\.left\)/);
  const diagnostics=readFileSync(new URL('./video-ai-position-scale-diagnostics.mjs',import.meta.url),'utf8');
  for(const stage of ['POSITION_SCALE_UI_SELECTION','POSITION_SCALE_UI_OBSERVATION','POSITION_SCALE_PREVIEW_OBSERVATION'])
    assert.ok(diagnostics.includes(stage));
  assert.match(studio,/function editorRequirementsError/);
  assert.match(studio,/AI 返回的剪辑计划未通过安全校验/);
  assert.match(studio,/setEditorAITaskBusy\(false\)/);
  assert.doesNotMatch(adapter,/page\.on\('console'[^\n]*console\.text\(\)|page\.on\('pageerror'[^\n]*error\.message/);
  const runner=readFileSync(new URL('./run-video-ai-position-scale-preflight.mjs',import.meta.url),'utf8');
  assert.ok(runner.indexOf('await adapter.undo(')<runner.indexOf('await adapter.redo('));
  assert.ok(runner.indexOf('await adapter.redo(')<runner.indexOf('await adapter.assertPersistence(redone,targetId)'));
  assert.ok(runner.indexOf('await adapter.assertPersistence(redone,targetId)')<runner.indexOf('await adapter.assertRenderPlan(redone,targetId)'));
});

test('ordinary test-user authentication reuses sign-in and getUser without exposing credentials',async()=>{
  const calls=[];
  const session={access_token:'ACCESS_TOKEN_NEVER_PRINT',user:{id:'USER_ID_NEVER_PRINT'}};
  const adapter=await createPositionScaleAdapter(metadataEnv,{supabase:{createClient:(url,key,options)=>{
    calls.push(['client',url,key,options.auth.persistSession]);
    return {auth:{signInWithPassword:async credentials=>{calls.push(['signIn',credentials.email,credentials.password]);return {data:{session},error:null};},
      getUser:async token=>{calls.push(['getUser',token]);return {data:{user:session.user},error:null};},stopAutoRefresh(){}}};
  }}});
  const authenticated=await adapter.authenticate();
  assert.equal(authenticated,session);
  assert.deepEqual(calls.map(item=>item[0]),['client','signIn','getUser']);
  assert.doesNotMatch(formatPositionScaleFailure(new PositionScaleGateError('POSITION_SCALE_AUTH')),/ACCESS_TOKEN|USER_ID|test-password|test-user/);
  await adapter.close();
});

test('missing or rejected test-user credentials stop safely before editor launch',async()=>{
  const missing={...metadataEnv,MEDCLIP_TEST_USER_A_PASSWORD:''};
  const missingAdapter=await createPositionScaleAdapter(missing);
  await assert.rejects(missingAdapter.authenticate(),error=>error.substage==='POSITION_SCALE_AUTH');
  await missingAdapter.close();
  const rejectedAdapter=await createPositionScaleAdapter(metadataEnv,{supabase:{createClient:()=>({auth:{
    signInWithPassword:async()=>({data:{session:null},error:new Error('private auth detail')}),
  }})}});
  await assert.rejects(rejectedAdapter.authenticate(),error=>{
    assert.equal(error.substage,'POSITION_SCALE_AUTH');
    assert.doesNotMatch(formatPositionScaleFailure(error),/private auth detail|test-password|ACCESS_TOKEN/);
    return true;
  });
  await rejectedAdapter.close();
});

test('connected-provider metadata requires connected DeepSeek and rejects secret-bearing fields',()=>{
  const safe={ok:true,connections:[{id:'connection-id',user_id:'user-id',provider:'deepseek',provider_resource_id:null,
    key_last4:'1234',status:'connected',last_validated_at:null,created_at:'date',updated_at:'date'}]};
  assert.equal(assertConnectedDeepSeekMetadata(safe),true);
  for(const payload of [{ok:true,connections:[]},{ok:true,connections:[{provider:'deepseek',status:'needs_update'}]},
    {ok:true,connections:[{...safe.connections[0],apiKey:'secret'}]},{...safe,api_key:'secret'}])
    assert.throws(()=>assertConnectedDeepSeekMetadata(payload),error=>error.substage==='POSITION_SCALE_PROVIDER_METADATA');
});

test('authenticated readiness metadata performs one list-only read and returns no secret fields',async()=>{
  const calls=[];
  const adapter=await createPositionScaleAdapter(metadataEnv,{supabase:{createClient:()=>({auth:{
    signInWithPassword:async()=>({data:{session:{access_token:'ACCESS_TOKEN_NEVER_PRINT',user:{id:'USER_ID_NEVER_PRINT'}}},error:null}),
    getUser:async()=>({data:{user:{id:'USER_ID_NEVER_PRINT'}},error:null}),stopAutoRefresh(){},
  },functions:{invoke:async(name,options)=>{calls.push([name,options.body]);return {data:{ok:true,connections:[{
    provider:'deepseek',status:'connected',key_last4:'1234',provider_resource_id:null,
  }]},error:null};}}})}});
  await adapter.authenticate();
  assert.deepEqual(await adapter.readProviderMetadata(),{deepseekPresent:true,deepseekStatus:'connected',metadataSafe:true});
  assert.deepEqual(calls,[['ai-credentials',{action:'list'}]]);
  await assert.rejects(adapter.readProviderMetadata(),error=>error.substage==='POSITION_SCALE_PROVIDER_METADATA');
  await adapter.close();
});

test('synthetic response matches the real Edge success envelope and exact trusted-C action',()=>{
  const {targetId}=projects();
  const response=createPositionScaleSyntheticResponse(targetId);
  assert.deepEqual(Object.keys(response).sort(),['metadata','ok','provider','result','task','usage']);
  assert.equal(response.ok,true);assert.equal(response.task,'editor.requirements_parse');assert.equal(response.provider,'deepseek');
  assert.deepEqual(response.result,{capability:'TEXT_REASONING',data:response.result.data});
  assert.deepEqual(response.usage,{input_tokens:1,output_tokens:1,total_tokens:2});
  assert.deepEqual(response.metadata,{providerUsed:'deepseek',taskType:'editor.requirements_parse',generationOccurred:false,providerFreeFixture:true});
  assert.deepEqual(response.result.data.actions,[{...POSITION_SCALE_ACTION,targetId}]);
  assert.equal(assertPositionScaleSyntheticResponse(response,targetId),true);
  assert.throws(()=>createPositionScaleSyntheticResponse(''),error=>error.substage==='POSITION_SCALE_ACTION_TARGET');
});

test('offline trusted-C to Edge envelope to runAITask extraction to parser and validator contract path passes',()=>{
  const {before,ids,targetId}=projects();
  const trustedC=ids[2];
  assert.equal(targetId,trustedC);
  const action=createPositionScaleAction(trustedC);
  assertPositionScaleAction(action,trustedC);
  const plan={summary:'Provider-free canonical position and scale fixture.',actions:[action],unsupported:[],warnings:[]};
  const edgeEnvelope=createPositionScaleSyntheticResponse(trustedC);
  assert.deepEqual(edgeEnvelope.result.data,plan);

  // runAITask returns the successful ai-tasks response body; EditorStudio reads result.data.
  const runAITaskEquivalent=response=>{
    assert.equal(response?.ok,true);
    assert.equal(response?.task,'editor.requirements_parse');
    return response;
  };
  const taskResult=runAITaskEquivalent(edgeEnvelope);
  const extractedPlan=taskResult.result.data;
  assert.deepEqual(Object.keys(extractedPlan).sort(),['actions','summary','unsupported','warnings']);
  const parsed=parseAIEditingPlan(extractedPlan);
  assert.deepEqual(parsed.actions[0],action);
  const applied=applyAIEditingPlan(parsed,{project:before,ownedAssetIds:new Set(before.assets.map(asset=>asset.id)),
    audioSourceDurationMs:before.audioSelection.sourceDurationMs});
  assert.equal(eligibleClips(applied.project)[2].id,trustedC);
  assert.deepEqual({x:eligibleClips(applied.project)[2].transform.x,y:eligibleClips(applied.project)[2].transform.y,
    scale:eligibleClips(applied.project)[2].transform.scale},{x:25,y:-25,scale:0.8});
  assert.deepEqual({x:eligibleClips(before)[2].transform.x,y:eligibleClips(before)[2].transform.y,
    scale:eligibleClips(before)[2].transform.scale},{x:0,y:0,scale:1});
});

test('synthetic success envelope matches the local Edge v70 provider-free fixture contract',async()=>{
  const fixture='valid_position_scale_top_right_80';
  const definition=getInternalTextTaskFixtureDefinition(fixture);
  const request=parseAITaskRequest({task:'editor.requirements_parse',provider:'deepseek',input:definition.input});
  const edge=await executeInternalTextTaskFixture('offline-test-user',request,fixture);
  const synthetic=createPositionScaleSyntheticResponse('trusted-C-placeholder');
  assert.deepEqual(Object.keys(synthetic).sort(),Object.keys(edge).sort());
  assert.deepEqual(Object.keys(synthetic.result).sort(),Object.keys(edge.result).sort());
  assert.deepEqual(Object.keys(synthetic.result.data).sort(),Object.keys(edge.result.data).sort());
  assert.deepEqual(Object.keys(synthetic.result.data.actions[0]).sort(),Object.keys(edge.result.data.actions[0]).sort());
  assert.deepEqual(synthetic.usage,edge.usage);
  assert.deepEqual(Object.keys(synthetic.metadata).sort(),Object.keys(edge.metadata).sort());
  assert.deepEqual({ok:synthetic.ok,task:synthetic.task,provider:synthetic.provider,capability:synthetic.result.capability,
    generationOccurred:synthetic.metadata.generationOccurred,providerFreeFixture:synthetic.metadata.providerFreeFixture},
  {ok:edge.ok,task:edge.task,provider:edge.provider,capability:edge.result.capability,
    generationOccurred:edge.metadata.generationOccurred,providerFreeFixture:edge.metadata.providerFreeFixture});
});

test('editor requires a complete task envelope before validating canonical parser input',()=>{
  const {before,targetId}=projects();
  const corrected=createPositionScaleSyntheticResponse(targetId);
  const legacy={ok:true,result:corrected.result,metadata:{providerFreeFixture:true,generationOccurred:false}};
  assert.throws(()=>assertPositionScaleSyntheticResponse(legacy,targetId));
  const tasksSource=readFileSync(new URL('../lib/ai/tasks.ts',import.meta.url),'utf8');
  const studioSource=readFileSync(new URL('../app/editor/EditorStudio.tsx',import.meta.url),'utf8');
  assert.match(tasksSource,/getSupabaseBrowserClient\(\)\.functions\.invoke\("ai-tasks",\s*\{ body: request \}\)/);
  assert.match(tasksSource,/return requireTaskResult\(safeData, safeData \? null : error\)/);
  assert.match(studioSource,/result\.task !== "editor\.requirements_parse" \|\| result\.provider !== selectedAIProvider/);
  assert.match(studioSource,/applyAIEditingPlan\(\s*review\.result\.result\.data,/);
  const runAITaskReturn=body=>{if(!body||typeof body!=='object'||!body.ok)throw new Error('safe task failure');return body;};
  const legacyParserInput=runAITaskReturn(legacy).result.data;
  assert.deepEqual(parseAIEditingPlan(legacyParserInput).actions[0],{...POSITION_SCALE_ACTION,targetId});
  const correctedParserInput=runAITaskReturn(corrected).result.data;
  assert.deepEqual(parseAIEditingPlan(correctedParserInput).actions[0],{...POSITION_SCALE_ACTION,targetId});
  assert.doesNotThrow(()=>applyAIEditingPlan(correctedParserInput,{project:before,ownedAssetIds:new Set(before.assets.map(asset=>asset.id)),
    audioSourceDurationMs:before.audioSelection.sourceDurationMs}));
});

test('browser parser rejects wrong wrappers, nesting, action container, serialized data, and unsafe action fields',()=>{
  const {targetId}=projects();const response=createPositionScaleSyntheticResponse(targetId);const plan=response.result.data;
  for(const wrong of [response,response.result,JSON.stringify(plan),{...plan,actions:{...plan.actions[0]}},
    {...plan,actions:[{...plan.actions[0],unknown:true}]},{...plan,actions:[{...plan.actions[0],x:'25'}]},
    {...plan,actions:[{...plan.actions[0],assetId:'asset-not-empty'}]}])
    assert.throws(()=>parseAIEditingPlan(wrong));
  const wrongTarget={...plan,actions:[{...plan.actions[0],targetId:'untrusted-target'}]};
  assert.throws(()=>applyAIEditingPlan(wrongTarget,{project:projects().before,ownedAssetIds:new Set(projects().before.assets.map(asset=>asset.id)),
    audioSourceDurationMs:projects().before.audioSelection.sourceDurationMs}));
});

test('authenticated browser wiring passes through list metadata but always intercepts generation locally',()=>{
  const adapter=readFileSync(new URL('./video-ai-position-scale-browser-adapter.mjs',import.meta.url),'utf8');
  const runner=readFileSync(new URL('./run-video-ai-position-scale-preflight.mjs',import.meta.url),'utf8');
  assert.ok(runner.indexOf('await adapter.authenticate()')<runner.indexOf('await adapter.openEditor(session'));
  assert.match(adapter,/browser\.newContext\(\)/);
  assert.match(adapter,/body\.action==='list'.*route\.continue\(\)/);
  assert.match(adapter,/generationOccurred:false,providerFreeFixture:true/);
  assert.doesNotMatch(adapter,/credentials:\[\]/);
  const aiTaskBranch=adapter.slice(adapter.indexOf("if(requestClass==='AI_TASKS')"),adapter.indexOf("if(requestClass==='AI_CREDENTIALS')"));
  assert.match(aiTaskBranch,/route\.fulfill\(/);
  assert.doesNotMatch(aiTaskBranch,/route\.continue\(/);
  assert.doesNotMatch(adapter,/MEDCLIP_INTERNAL_LIVE_VALIDATION_SECRET/);
});

test('runner authenticates before editor launch and stops before launch on auth failure',async()=>{
  const calls=[];
  const base={
    provenance:async()=>({pid:1,cwd:'local',gitHead:'head',hashes:{runner:'a',browserAdapter:'b',diagnostics:'c'}}),
    remoteMetadata:async()=>({version:70,status:'ACTIVE'}),
    armProviderGuard:async()=>calls.push('guard'),
    authenticate:async()=>{calls.push('auth');return {access_token:'mock-session',user:{id:'mock-user'}};},
    openEditor:async session=>{calls.push(['editor',session.access_token]);throw new Error('stop after auth-order check');},
    close:async()=>{},
  };
  await assert.rejects(runPositionScalePreflight(['--mode=preflight'],{},async()=>base),error=>error.substage==='POSITION_SCALE_EDITOR_LOAD');
  assert.deepEqual(calls,['guard','auth',['editor','mock-session']]);
  const rejected={...base,authenticate:async()=>{calls.push('auth-failed');throw new PositionScaleGateError('POSITION_SCALE_AUTH');},
    openEditor:async()=>{calls.push('unexpected-editor');}};
  calls.length=0;
  await assert.rejects(runPositionScalePreflight(['--mode=preflight'],{},async()=>rejected),error=>error.substage==='POSITION_SCALE_AUTH');
  assert.deepEqual(calls,['guard','auth-failed']);
});

test('apply entry fails safely before UI submit when no connected provider is available',()=>{
  assert.doesNotThrow(()=>assertPositionScaleApplyEntryReady({targetTrusted:true,providerEnabled:true}));
  for(const input of [{targetTrusted:false,providerEnabled:true},{targetTrusted:true,providerEnabled:false}])
    assert.throws(()=>assertPositionScaleApplyEntryReady(input),error=>{
      assert.equal(error.substage,'POSITION_SCALE_ACTION_TARGET');
      assert.doesNotMatch(formatPositionScaleFailure(error),/clip-secret|asset-secret|PAT|Bearer/);
      return true;
    });
});

test('provider-free fixture response is structurally wired to the genuine editor apply and history path',()=>{
  const adapter=readFileSync(new URL('./video-ai-position-scale-browser-adapter.mjs',import.meta.url),'utf8');
  const studio=readFileSync(new URL('../app/editor/EditorStudio.tsx',import.meta.url),'utf8');
  assert.match(adapter,/createPositionScaleSyntheticResponse\(targetId\)/);
  assert.match(adapter,/route\.fulfill\(\{status:200,contentType:'application\/json',body:JSON\.stringify\(synthetic\)\}\)/);
  assert.match(adapter,/task!=='editor\.requirements_parse'/);
  assert.match(studio,/runAITask\(\{ task: "editor\.requirements_parse", provider: selectedAIProvider, input \}\)/);
  assert.match(studio,/applyAIEditingPlan\(\s*review\.result\.result\.data,\s*\{/);
  assert.match(studio,/setEditorAIUndoProject\(cloneProject\(editorProject\)\)/);
  assert.match(studio,/handleEditorProjectChange\(applied\.project\)/);
  assert.match(studio,/window\.localStorage\.setItem\("medclip-editor-draft-v1", JSON\.stringify\(editorProject\)\)/);
});

test('live component source orders apply result, undo snapshot, commit callback, and success summary',()=>{
  const studio=readFileSync(new URL('../app/editor/EditorStudio.tsx',import.meta.url),'utf8');
  const start=studio.indexOf('const confirmRequirementsPlan');
  const end=studio.indexOf('const requirementsReviewPanel',start);
  const handler=studio.slice(start,end);
  const applyAt=handler.indexOf('const applied = validateRequirementsPlan(currentRequirementsReview)');
  const changedAt=handler.indexOf('if (applied.project === editorProject || !applied.applied.length) return;');
  const undoAt=handler.indexOf('setEditorAIUndoProject(cloneProject(editorProject))');
  const commitAt=handler.indexOf('handleEditorProjectChange(applied.project)');
  const summaryAt=handler.indexOf('setEditorAIApplyResult(applied)');
  assert.ok(applyAt>=0 && applyAt<changedAt && changedAt<undoAt && undoAt<commitAt && commitAt<summaryAt);
  const commit=studio.slice(studio.indexOf('const handleEditorProjectChange'),studio.indexOf('const handleEditorPreviewTimeChange'));
  assert.match(commit,/=> \{\s*setEditorProject\(nextProject\)/);
  assert.doesNotMatch(commit,/return;/);
  assert.match(studio,/const \[editorProject, setEditorProject\] = useState<EditorProject \| null>\(null\)/);
  assert.match(studio,/setMatchSegments\(projectToMatchSegments\(nextProject\)\)/);
});

test('TimelineEditor Undo and Redo propagate snapshots without resetting selection or playhead',()=>{
  const timeline=readFileSync(new URL('../app/TimelineEditor.tsx',import.meta.url),'utf8');
  const studio=readFileSync(new URL('../app/editor/EditorStudio.tsx',import.meta.url),'utf8');
  const undo=timeline.slice(timeline.indexOf('const undo = () =>'),timeline.indexOf('const redo = () =>'));
  const redo=timeline.slice(timeline.indexOf('const redo = () =>'),timeline.indexOf('const durationMs'));
  const ordered=[
    'const previous = historyRef.current.pop()',
    'futureRef.current.push(cloneProject(draftRef.current))',
    'draftRef.current = previous',
    'setDraft(previous)',
    'onProjectChange(previous)',
    'setHistoryVersion((value) => value + 1)',
  ];
  for(let index=1;index<ordered.length;index++)
    assert.ok(undo.indexOf(ordered[index-1])<undo.indexOf(ordered[index]),`Undo order ${index} is source-authored`);
  assert.match(redo,/const next = futureRef\.current\.pop\(\)[\s\S]*historyRef\.current\.push\(cloneProject\(draftRef\.current\)\)[\s\S]*draftRef\.current = next[\s\S]*setDraft\(next\)[\s\S]*onProjectChange\(next\)/);
  for(const body of [undo,redo]) {
    assert.doesNotMatch(body,/setSelection\(/);
    assert.doesNotMatch(body,/setPlayheadMs\(/);
    assert.doesNotMatch(body,/playheadRef\.current\s*=/);
  }
  assert.match(timeline,/const selectedClip = selection\?\.kind === "clip"[\s\S]*allClips\.find\(\(clip\) => clip\.id === selection\.id\)/);
  assert.match(timeline,/const activeClip = useMemo\([\s\S]*\[draft\.tracks, playheadMs\]\)/);
  assert.doesNotMatch(timeline,/useEffect\(\(\) => \{\s*(?:draftRef\.current = cloneProject\(project\);\s*)?setDraft\(cloneProject\(project\)\)/);
  const parent=studio.slice(studio.indexOf('const handleEditorProjectChange'),studio.indexOf('const handleEditorPreviewTimeChange'));
  assert.match(parent,/setEditorProject\(nextProject\)[\s\S]*setMatchSegments\(projectToMatchSegments\(nextProject\)\)/);
  assert.match(studio,/window\.localStorage\.setItem\("medclip-editor-draft-v1", JSON\.stringify\(editorProject\)\)/);
});

test('TimelineEditor UI and preview are sourced from its project-derived draft',()=>{
  const timeline=readFileSync(new URL('../app/TimelineEditor.tsx',import.meta.url),'utf8');
  assert.match(timeline,/const \[draft, setDraft\] = useState\(\(\) => cloneProject\(project\)\)/);
  assert.match(timeline,/value=\{selectedClip\.transform\.x\}/);
  assert.match(timeline,/value=\{selectedClip\.transform\.y\}/);
  assert.match(timeline,/value=\{selectedClip\.transform\.scale\}/);
  assert.match(timeline,/transform: clipPositionScaleCss\(activeClip\?\.transform/);
});

test('fixture callback preserves granular safe stage and same-process provenance on failure',async()=>{
  const provenance={pid:42,cwd:'D:\\private\\workspace',gitHead:'a'.repeat(40),hashes:{runner:'b'.repeat(64),browserAdapter:'c'.repeat(64),diagnostics:'d'.repeat(64)}};
  const adapter={provenance:async()=>provenance,remoteMetadata:async()=>({version:70,status:'ACTIVE'}),
    armProviderGuard:async()=>{},authenticate:async()=>({access_token:'session-token',user:{id:'test-user'}}),
    openEditor:async()=>({httpStatus:200}),
    fixture:async report=>{report('POSITION_SCALE_FIXTURE_ASSET_C');throw new Error('private clip-secret-987');},close:async()=>{}};
  await assert.rejects(runPositionScalePreflight(['--mode=preflight'],{},async()=>adapter),error=>{
    assert.equal(error.substage,'POSITION_SCALE_FIXTURE_ASSET_C');
    const output=formatPositionScaleFailure(error);
    assert.match(output,/PROVENANCE PID = 42/);
    assert.match(output,/PROVENANCE CWD = <local workspace>/);
    assert.match(output,/PROVENANCE SHA256 runner = [a-f0-9]{64}/);
    assert.doesNotMatch(output,/private|clip-secret/);
    return true;
  });
});

test('adapter gate failures retain same-process provenance through runner formatting',async()=>{
  const {before,ids,targetId}=projects();
  const provenance={pid:43,cwd:'D:\\private\\workspace',gitHead:'a'.repeat(40),hashes:{runner:'b'.repeat(64),browserAdapter:'c'.repeat(64),diagnostics:'d'.repeat(64),sharedReorderBrowserAdapter:'e'.repeat(64)}};
  const adapter={provenance:async()=>provenance,remoteMetadata:async()=>({version:70,status:'ACTIVE'}),armProviderGuard:async()=>{},
    authenticate:async()=>({access_token:'session-token',user:{id:'test-user'}}),openEditor:async()=>({httpStatus:200}),
    fixture:async()=>({project:before,clipIds:ids,expectedClipIds:ids,assetIds:before.assets.map(asset=>asset.id),contextOrder:['A','B','C'],contextTransform:{x:0,y:0,scale:1}}),
    captureProject:async()=>before,applyCanonicalAction:async()=>{throw new PositionScaleGateError('POSITION_SCALE_PRODUCT_APPLY');},close:async()=>{}};
  await assert.rejects(runPositionScalePreflight(['--mode=preflight'],{},async()=>adapter),error=>{
    const output=formatPositionScaleFailure(error);
    assert.equal(error.substage,'POSITION_SCALE_PRODUCT_APPLY');
    assert.match(output,/PROVENANCE PID = 43/);
    assert.match(output,/PROVENANCE CWD = <local workspace>/);
    assert.match(output,/PROVENANCE HEAD = [a-f0-9]{40}/);
    assert.match(output,/PROVENANCE SHA256 sharedReorderBrowserAdapter = [a-f0-9]{64}/);
    assert.doesNotMatch(output,/private|session-token|test-user/);
    return true;
  });
});

test('failure provenance survives cleanup failure and cleanup-only failure formatting',async()=>{
  const provenance={pid:44,cwd:'D:\\private\\workspace',gitHead:'a'.repeat(40),hashes:{runner:'b'.repeat(64),browserAdapter:'c'.repeat(64),diagnostics:'d'.repeat(64)}};
  const earlyFailure={provenance:async()=>provenance,remoteMetadata:async()=>{throw new Error('private remote failure');},close:async()=>{throw new Error('private close failure');}};
  await assert.rejects(runPositionScalePreflight(['--mode=preflight'],{},async()=>earlyFailure),error=>{
    const output=formatPositionScaleFailure(error);
    assert.match(output,/PROVENANCE PID = 44/);assert.match(output,/PROVENANCE HEAD = [a-f0-9]{40}/);
    assert.doesNotMatch(output,/private remote|private close/);return true;
  });
});

test('blocked external media/model requests do not count as Provider generation calls',()=>{
  assert.equal(classifyPositionScaleRequest('http://localhost:3000/editor','GET','http://localhost:3000'),'LOCAL');
  assert.equal(classifyPositionScaleRequest('https://cdn.example/model.bin','GET','http://localhost:3000'),'BLOCKED_EXTERNAL');
  assert.equal(classifyPositionScaleRequest('https://project.supabase.co/functions/v1/ai-tasks','POST','http://localhost:3000'),'AI_TASKS');
  assert.equal(classifyPositionScaleRequest('https://project.supabase.co/functions/v1/other','POST','http://localhost:3000'),'BLOCKED_FUNCTION');
});

test('remote version/status gate stops before provider guard or browser launch',async()=>{
  const calls=[];
  const adapter={
    provenance:async()=>({pid:1,cwd:'local',gitHead:'head',hashes:{runner:'a',browserAdapter:'b',diagnostics:'c'}}),
    remoteMetadata:async()=>({version:69,status:'ACTIVE'}),
    armProviderGuard:async()=>calls.push('arm'),openEditor:async()=>calls.push('browser'),close:async()=>calls.push('close'),
  };
  await assert.rejects(runPositionScalePreflight(['--mode=preflight'],{},async()=>adapter),error=>{
    assert.equal(error.substage,'POSITION_SCALE_REMOTE_VERSION');return true;
  });
  assert.deepEqual(calls,['close']);
});

test('REST metadata gate accepts only ai-tasks ACTIVE version 70 with numeric version',async()=>{
  let request;
  const adapter=await createPositionScaleAdapter(metadataEnv,{fetch:async(url,init)=>{request={url,init};return {ok:true,json:async()=>({name:'ai-tasks',status:'ACTIVE',version:70})};}});
  const metadata=await adapter.remoteMetadata();
  assert.deepEqual(metadata,{status:'ACTIVE',version:70});
  assert.ok(request.url.endsWith('/functions/ai-tasks'));
  assert.equal(request.init.headers.Authorization.startsWith('Bearer '),true);
  assert.deepEqual(await verifyPositionScaleRemoteMetadata({remoteMetadata:async()=>metadata}),metadata);
  await adapter.close();
});

test('metadata gate rejects v69 and inactive functions at distinct substages',async()=>{
  for(const [metadata,substage] of [[{status:'ACTIVE',version:69},'POSITION_SCALE_REMOTE_VERSION'],[{status:'INACTIVE',version:70},'POSITION_SCALE_REMOTE_STATUS']])
    await assert.rejects(verifyPositionScaleRemoteMetadata({remoteMetadata:async()=>metadata}),error=>error.substage===substage);
});

test('metadata REST parser classifies malformed JSON and transport failures without leaking credentials',async()=>{
  for(const [fetch,expected] of [
    [async()=>{throw new Error('PAT_SECRET_NEVER_PRINT');},'POSITION_SCALE_REMOTE_METADATA_EXEC'],
    [async()=>{const error=new TypeError('fetch failed');error.cause={code:'EACCES'};throw error;},'POSITION_SCALE_REMOTE_METADATA_EXEC'],
    [async()=>({ok:true,json:async()=>{throw new Error('malformed');}}),'POSITION_SCALE_REMOTE_METADATA_PARSE'],
    [async()=>({ok:false,status:503,json:async()=>({})}),'POSITION_SCALE_REMOTE_METADATA_EXEC'],
    [metadataFetcher({status:'ACTIVE',version:'70'}),'POSITION_SCALE_REMOTE_METADATA_PARSE'],
  ]) {
    const adapter=await createPositionScaleAdapter(metadataEnv,{fetch});
    await assert.rejects(adapter.remoteMetadata(),error=>{
      assert.equal(error.substage,expected);
      assert.doesNotMatch(formatPositionScaleFailure(error),/PAT_SECRET_NEVER_PRINT|Authorization|Bearer/);
      return true;
    });
    await adapter.close();
  }
});

test('missing management token fails safely before metadata execution',async()=>{
  const {SUPABASE_ACCESS_TOKEN:_,...withoutToken}=metadataEnv;
  await assert.rejects(createPositionScaleAdapter(withoutToken),error=>{
    assert.equal(error.substage,'POSITION_SCALE_REMOTE_METADATA_EXEC');
    assert.doesNotMatch(formatPositionScaleFailure(error),/PAT_SECRET_NEVER_PRINT|Bearer/);
    return true;
  });
});
