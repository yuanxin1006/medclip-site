import { setup } from './video-ai-reorder-test-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMode, once, runReorderAcceptance, assertCanonical, assertPreserved, normalizePersistedValue, expectedReorderedProjectDuration, REORDER_REQUIREMENT } from './run-video-ai-reorder-live-acceptance.mjs';
import { createSafeEditorAIContext, applyAIEditingPlan } from '../app/editor-ai-requirements.ts';
import { inspectPreLiveSafeEditorContext } from './video-ai-live-acceptance-harness.ts';
import { EXPECTED_AI_TASKS_VERSION, sourceHash, compareSources } from './video-ai-reorder-identity.mjs';
import { formatAcceptanceFailure, LIVE_ACCEPTANCE_SUBSTAGES, gateScope } from './video-ai-reorder-diagnostics.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const allow = { MEDCLIP_ALLOW_REORDER_LIVE:'YES' };

for (const [name,args,env] of [['missing mode',[],{}],['unknown mode',['--mode=no'],{}],['live without gate',['--mode=live'],{}],['env without mode',[],allow],['extra CLI arguments',['--mode=live','--requirement=other'],allow]]) test(name,()=>assert.throws(()=>parseMode(args,env)));
test('preflight has zero provider submissions, including with env gate',async()=>{const s=setup();assert.equal((await runReorderAcceptance(['--mode=preflight'],allow,s.adapter)).providerCalls,0);assert.equal(s.clicks(),0);assert.equal(s.closed(),true);});
for (const gate of ['reachability','authenticate','identity','smoke','openEditor']) test(`${gate} failure blocks before submit`,async()=>{const s=setup();s.adapter[gate]=async()=>{throw Error('mock failure');};await assert.rejects(runReorderAcceptance(['--mode=live'],allow,s.adapter));assert.equal(s.clicks(),0);assert.equal(s.closed(),true);});
for (const [name,value] of [
  ['previous verifier version rejected',{version:68,hashMismatches:0,fileCount:1}],
  ['predeploy remote version rejected',{version:69,hashMismatches:0,fileCount:1}],
  ['observed version rejects hash mismatch',{version:70,hashMismatches:1,fileCount:1}],
  ['observed version requires source identity evidence',{version:70,hashMismatches:0,fileCount:0}],
]) test(name,async()=>{const s=setup();s.adapter.identity=async()=>value;await assert.rejects(runReorderAcceptance(['--mode=live'],allow,s.adapter));assert.equal(s.clicks(),0);});
test('observed version 70 is accepted only with expected source identity',async()=>{const s=setup();const result=await runReorderAcceptance(['--mode=preflight'],allow,s.adapter);assert.equal(EXPECTED_AI_TASKS_VERSION,70);assert.equal(result.remoteVersion,70);assert.equal(result.sourceIdentity,'PASS');assert.equal(s.clicks(),0);});
for (const smoke of [{pass:false,providerCalls:0},{pass:true,providerCalls:1}]) test('smoke failure blocks',async()=>{const s=setup();s.adapter.smoke=async()=>smoke;await assert.rejects(runReorderAcceptance(['--mode=live'],allow,s.adapter));assert.equal(s.clicks(),0);});
test('three owned clips, A B C order, distinct dual gate',()=>{const s=setup();const e=inspectPreLiveSafeEditorContext(s.input);assert.equal(e.eligible,true);assert.equal(e.clipCount,3);assert.equal(e.expectedReferencePresent,true);assert.equal(e.targetReferenceDistinct,true);assert.equal(e.expectedOrderMatches,true);});
for(const mutation of ['target','reference','equal','order','unowned','extra']) test(`safe context rejects ${mutation} with zero submits`,async()=>{const s=setup();const c=JSON.parse(s.input.serializedContext);if(mutation==='target')c.clips.pop();if(mutation==='reference')c.clips.shift();if(mutation==='equal')s.input.expectedReferenceClipId=s.input.expectedTargetClipId;if(mutation==='order')c.clips.reverse();if(mutation==='unowned')c.assets=[];if(mutation==='extra')c.clips.push({...c.clips[0],id:'extra'});s.input.serializedContext=JSON.stringify(c);await assert.rejects(runReorderAcceptance(['--mode=live'],allow,s.adapter));assert.equal(s.clicks(),0);});
test('mock live uses response-first harness, C A B, preservation, undo and redo',async()=>{const s=setup();assert.equal((await runReorderAcceptance(['--mode=live'],allow,s.adapter)).result,'LIVE_PASS');assert.deepEqual(s.events,['observer','context','submit']);assert.equal(s.clicks(),1);assert.equal(s.closed(),true);});
test('LIVE_ACCEPTANCE substage allowlist is fixed and complete',()=>assert.deepEqual(LIVE_ACCEPTANCE_SUBSTAGES,[
  'LIVE_REQUIREMENT_PREPARE','LIVE_CONTEXT_VALIDATE','LIVE_SUBMIT','LIVE_RESPONSE_WAIT','LIVE_UI_OUTCOME','LIVE_STATE_CAPTURE',
  'LIVE_RESPONSE_STATUS','LIVE_RESPONSE_COMPLETED','LIVE_RESPONSE_OK','LIVE_ACTION_COUNT','LIVE_ACTION_TYPE','LIVE_ACTION_TARGET',
  'LIVE_ACTION_REFERENCE','LIVE_ACTION_PLACEMENT','LIVE_FINAL_ORDER','LIVE_FINAL_PRESERVATION',
  'LIVE_PRESERVE_IDENTITY','LIVE_PRESERVE_BINDINGS','LIVE_PRESERVE_SOURCE_RANGE','LIVE_PRESERVE_SPEED',
  'LIVE_PRESERVE_TRANSFORM','LIVE_PRESERVE_DURATION','LIVE_PRESERVE_TIMELINE_PACKING','LIVE_PRESERVE_PROJECT_DURATION',
  'LIVE_PRESERVE_CAPTIONS','LIVE_PRESERVE_AUDIO_SELECTION','LIVE_PRESERVE_AUDIO_TRACKS','LIVE_PRESERVE_ASSETS','LIVE_PREVIEW_EXPORT',
  'LIVE_UNDO','LIVE_UNDO_STATE','LIVE_REDO','LIVE_REDO_STATE','LIVE_FINAL_REQUEST_COUNT',
]));
const injectedLiveFailures = [
  ['LIVE_REQUIREMENT_PREPARE',s=>s.adapter.prepareRequirement=async()=>{throw Error('secret requirement failure');}],
  ['LIVE_CONTEXT_VALIDATE',s=>s.adapter.readSafeContext=async()=>{throw Error('secret context failure');}],
  ['LIVE_SUBMIT',s=>s.adapter.harness.submitOnce=async()=>{throw Error('secret submit failure');}],
  ['LIVE_RESPONSE_WAIT',s=>s.adapter.harness.waitForResponse=async()=>{throw Error('secret response failure');}],
  ['LIVE_UI_OUTCOME',s=>s.adapter.harness.readEditorSurface=async()=>{throw Error('secret UI failure');}],
  ['LIVE_STATE_CAPTURE',s=>s.adapter.harness.captureEditorState=async()=>{throw Error('secret state failure');}],
  ['LIVE_RESPONSE_STATUS',s=>s.response.httpStatus=500],
  ['LIVE_RESPONSE_COMPLETED',s=>s.response.responseCompleted=false],
  ['LIVE_RESPONSE_OK',s=>s.response.ok=false],
  ['LIVE_ACTION_COUNT',s=>s.response.canonical.actions=[]],
  ['LIVE_ACTION_TYPE',s=>s.response.canonical.actions[0].type='REMOVE_CLIP'],
  ['LIVE_ACTION_TARGET',s=>s.response.canonical.actions[0].targetId='internal-clip-id'],
  ['LIVE_ACTION_REFERENCE',s=>s.response.canonical.actions[0].referenceId='internal-reference-id'],
  ['LIVE_ACTION_PLACEMENT',s=>s.response.canonical.actions[0].placement='AFTER'],
  ['LIVE_FINAL_ORDER',s=>s.adapter.harness.captureEditorState=async()=>{const bad=structuredClone(s.final);bad.tracks[0].clips[0].id=s.ids[0];return bad;}],
  ['LIVE_PRESERVE_TRANSFORM',s=>{const capture=s.adapter.harness.captureEditorState;s.adapter.harness.captureEditorState=async()=>{const bad=await capture();bad.tracks[0].clips[0].transform={changed:true};return bad;};}],
  ['LIVE_PREVIEW_EXPORT',s=>s.adapter.assertPreviewAndExport=async()=>{throw Error('secret preview failure');}],
  ['LIVE_UNDO',s=>s.adapter.undo=async()=>{throw Error('secret undo failure');}],
  ['LIVE_PRESERVE_PROJECT_DURATION',s=>s.adapter.captureProject=async()=>{const bad=structuredClone(s.project);bad.durationMs++;return bad;}],
  ['LIVE_REDO',s=>s.adapter.redo=async()=>{throw Error('secret redo failure');}],
  ['LIVE_PRESERVE_PROJECT_DURATION',s=>{s.adapter.redo=async()=>{};let captures=0;s.adapter.captureProject=async()=>{const bad=structuredClone(++captures===1?s.project:s.final);if(captures===2)bad.durationMs++;return bad;};}],
  ['LIVE_FINAL_REQUEST_COUNT',s=>{let reads=0;s.adapter.harness.getRequestCount=()=>++reads<=2?s.clicks():2;}],
];
for(const [expected,inject] of injectedLiveFailures)test(`live failure retains ${expected}`,async()=>{
  const s=setup();inject(s);
  await assert.rejects(runReorderAcceptance(['--mode=live'],allow,s.adapter),error=>{
    assert.equal(error.gate,'LIVE_ACCEPTANCE');assert.equal(error.code,'ASSERTION_FAILED');assert.equal(error.substage,expected);
    const rendered=formatAcceptanceFailure(error,false);assert.match(rendered,new RegExp(`SUBSTAGE = ${expected}`));
    assert.doesNotMatch(rendered,/internal-clip-id|internal-reference-id|secret/);return true;
  });
});
test('successful mocked run satisfies exactly-once canonical reorder, preservation, preview, undo and redo',async()=>{
  const s=setup();const result=await runReorderAcceptance(['--mode=live'],allow,s.adapter);
  assert.equal(result.result,'LIVE_PASS');assert.equal(s.clicks(),1);assert.equal(s.response.canonical.actions[0].type,'REORDER_CLIP');
  assert.deepEqual(s.final.tracks.flatMap(t=>t.clips).map(c=>c.id),[s.ids[2],s.ids[0],s.ids[1]]);
  assert.deepEqual(s.events,['observer','context','submit']);assert.equal(s.closed(),true);
});
test('LIVE_ACCEPTANCE diagnostics exclude raw errors, provider/prompt bodies, IDs, storage, HTML, credentials, and stack traces',async()=>{
  const s=setup(),clipIds=s.project.tracks.flatMap(t=>t.clips).map(c=>c.id),assetIds=s.project.assets.map(a=>a.id);
  const storage=JSON.stringify(s.project),hidden=[
    'sk-live-fake-api-key','ghp_fake_personal_token','internal-validation-secret','raw provider response body',
    REORDER_REQUIREMENT,'clip-internal-id','asset-internal-id',...clipIds,...assetIds,storage,
    '<html><body>private page</body></html>','Error: raw exception with private details','at private.stack.frame (secret.js:1:1)',
  ];
  s.adapter.prepareRequirement=async()=>{throw new Error(hidden.join('|'));};
  await assert.rejects(runReorderAcceptance(['--mode=live'],allow,s.adapter),error=>{
    const outputs=[JSON.stringify(error),formatAcceptanceFailure(error,false),String(error),error.stack];
    for(const output of outputs)for(const value of hidden)assert.ok(!output.includes(value));
    assert.ok(formatAcceptanceFailure(error,false).includes('SUBSTAGE = LIVE_REQUIREMENT_PREPARE'));
    return true;
  });
});
for (const [key,value] of [['targetId','wrong'],['referenceId','wrong'],['placement','AFTER'],['type','REMOVE_CLIP']]) test(`wrong canonical ${key} rejected`,()=>{const s=setup();s.response.canonical.actions[0][key]=value;assert.throws(()=>assertCanonical(s.response,s.ids));});
test('second submit blocked even after first failure',async()=>{let n=0;const submit=once(async()=>{n++;throw Error('failed');});await assert.rejects(submit());await assert.rejects(submit(),/Second submit/);assert.equal(n,1);});
test('timeout never retries',async()=>{const s=setup();s.adapter.harness.timeoutMs=5;s.adapter.harness.waitForResponse=()=>new Promise(()=>{});await assert.rejects(runReorderAcceptance(['--mode=live'],allow,s.adapter));assert.equal(s.clicks(),1);assert.equal(s.closed(),true);});
for(const key of ['id','sourceInMs','sourceOutMs','timelineEndMs','speedCurve','assetId','transform'])test(`preservation detects changed ${key}`,()=>{const s=setup();const changed=structuredClone(s.final);const clip=changed.tracks.flatMap(t=>t.clips)[0];clip[key]=key==='speedCurve'?[]:key==='transform'?{}:typeof clip[key]==='number'?clip[key]+1:'changed';assert.throws(()=>assertPreserved(s.project,changed,[s.ids[2],s.ids[0],s.ids[1]]));});
test('source hash normalizes Windows line endings and rejects source mutation',()=>{assert.equal(sourceHash('a\r\n'),sourceHash('a\n'));assert.notEqual(sourceHash('a'),sourceHash('b'));});
test('identity compares actual files and rejects missing remote source',async()=>{const root=await mkdtemp(join(tmpdir(),'reorder-test-'));try{for(const side of ['local','remote'])for(const dir of ['ai-tasks','_shared']){await mkdir(join(root,side,dir),{recursive:true});await writeFile(join(root,side,dir,dir==='ai-tasks'?'index.ts':'x.ts'),dir==='ai-tasks'?"import {x} from '../_shared/x.ts';":'export const x=1;');}assert.deepEqual(await compareSources(join(root,'local'),join(root,'remote')),{fileCount:2,hashMismatches:0});await rm(join(root,'remote','_shared','x.ts'));assert.equal((await compareSources(join(root,'local'),join(root,'remote'))).hashMismatches,1);}finally{await rm(root,{recursive:true,force:true});}});
import { buildOwnedAssetAcceptanceFixtureThroughEditor } from './video-ai-owned-asset-fixture.ts';
import { readEditorState } from './video-ai-reorder-browser-adapter.mjs';
test('owned helper registers all three uploads before generation; editor IDs and bindings survive filtering',async()=>{
  const s=setup(), actions=[];
  const files=s.project.assets.map(asset=>({name:asset.name,mimeType:'video/mp4',buffer:new Uint8Array([0])}));
  const locator=selector=>({nth:()=>locator(selector),setInputFiles:async file=>actions.push(`upload:${file.name}`),waitFor:async()=>{},click:async()=>actions.push(`click:${selector}`),fill:async()=>{},isChecked:async()=>true,check:async()=>{}});
  const page={locator,waitForFunction:async()=>{},evaluate:async()=>JSON.stringify(s.project)};
  const fixture=await buildOwnedAssetAcceptanceFixtureThroughEditor(page,{video:files[0],additionalVideos:files.slice(1),audio:{name:'disposable.wav',mimeType:'audio/wav',buffer:new Uint8Array([0])},subtitleText:'Disposable subtitles',prepareGeneratedProject:async()=>actions.push('production-controls')});
  for(const file of files)assert.ok(actions.indexOf(`upload:${file.name}`)<actions.indexOf('click:button.generate-button'));
  assert.equal(fixture.registeredAssets.length,3);
  assert.deepEqual(fixture.preLiveContext.expectedClipIds,s.ids);
  assert.equal(inspectPreLiveSafeEditorContext(fixture.preLiveContext).eligible,true);
});
test('browser snapshot resolves committed state and real owned uploads; rejects restored metadata alone',async()=>{
  const s=setup(), node={};
  const values=[s.project,s.project.assets.map(a=>({...a,kind:'视频',preview:'blob:owned'})),s.project.tracks.flatMap(t=>t.clips).map(c=>({id:c.id,assetId:c.assetId,start:c.timelineStartMs/1000,end:c.timelineEndMs/1000})),[{id:'audio',name:'test',url:'blob:audio',duration:3}]];
  function hook(values){return values.length?{memoizedState:values[0],next:hook(values.slice(1))}:null;}
  node.__reactFiber$test={memoizedState:hook(values),return:null};
  const oldDocument=globalThis.document,oldStorage=globalThis.localStorage;
  globalThis.document={querySelector:()=>node};globalThis.localStorage={getItem:()=>JSON.stringify(s.project)};
  try{const state=await readEditorState({evaluate:async fn=>fn()});assert.deepEqual(state.ownedIds,s.project.assets.map(a=>a.id));values.splice(1,1);node.__reactFiber$test.memoizedState=hook(values);await assert.rejects(readEditorState({evaluate:async fn=>fn()}),/owned uploads/);}finally{globalThis.document=oldDocument;globalThis.localStorage=oldStorage;}
});
test('late context invalidation is blocked by the harness with zero action clicks',async()=>{const s=setup();s.adapter.readSafeContext=async()=>({...s.input,expectedReferenceClipId:'missing'});await assert.rejects(runReorderAcceptance(['--mode=live'],allow,s.adapter));assert.equal(s.clicks(),0);assert.deepEqual(s.events,['observer']);});
test('second network request observed during editor capture is rejected',async()=>{const s=setup();s.adapter.harness.getRequestCount=()=>s.clicks()===0?0:2;await assert.rejects(runReorderAcceptance(['--mode=live'],allow,s.adapter),{gate:'LIVE_ACCEPTANCE',code:'ASSERTION_FAILED'});assert.equal(s.clicks(),1);});
for(const key of ['captions','audioSelection','assets'])test(`invariant rejects changed ${key}`,()=>{const s=setup();const changed=structuredClone(s.final);changed[key]=key==='audioSelection'?{}:key==='captions'?[{id:'changed',text:'changed',startMs:1,endMs:2}]:[];assert.throws(()=>assertPreserved(s.project,changed,[s.ids[2],s.ids[0],s.ids[1]]));});
function packedFrom(before, order) {
  const after=structuredClone(before), track=after.tracks.find(t=>t.type==='video');
  const byId=new Map(track.clips.map(c=>[c.id,c]));
  const origin=Math.min(...track.clips.map(c=>c.timelineStartMs));let cursor=origin;
  track.clips=order.map(id=>byId.get(id));
  for(const clip of track.clips){const duration=clip.timelineEndMs-clip.timelineStartMs;clip.timelineStartMs=cursor;clip.timelineEndMs=cursor+duration;cursor=clip.timelineEndMs;}
  after.durationMs=expectedReorderedProjectDuration(after,before.durationMs);
  return after;
}
function nonzeroFixture(priorDuration=16000) {
  const s=setup(), before=structuredClone(s.project), clips=before.tracks.find(t=>t.type==='video').clips;
  before.durationMs=priorDuration;
  [[500,2500],[4000,7500],[9000,12000]].forEach(([start,end],i)=>{clips[i].timelineStartMs=start;clips[i].timelineEndMs=end;});
  before.captions[0].confidence=undefined;before.captions[0].needsReview=undefined;before.captions[0].boundaryClipped=undefined;
  return {before,ids:s.ids};
}
test('persisted normalizer is symmetric, omits undefined object properties, preserves null and order, and does not mutate',()=>{
  const left={caption:{text:'same',confidence:undefined},list:[1,2]},right={caption:{text:'same'},list:[1,2]},snapshot=structuredClone(left);
  assert.deepEqual(normalizePersistedValue(left),normalizePersistedValue(right));assert.deepEqual(left,snapshot);
  assert.notDeepEqual(normalizePersistedValue({value:null}),normalizePersistedValue({}));
  assert.notDeepEqual(normalizePersistedValue([1,2]),normalizePersistedValue([2,1]));
});
test('caption preservation accepts own undefined versus absent after JSON persistence',()=>{
  const {before,ids}=nonzeroFixture(), after=packedFrom(before,[ids[2],ids[0],ids[1]]);
  after.captions=JSON.parse(JSON.stringify(after.captions));
  assert.doesNotThrow(()=>assertPreserved(before,after,[ids[2],ids[0],ids[1]]));
});
test('other persisted structural collections accept own undefined versus absent',()=>{
  const s=setup(),before=structuredClone(s.project),after=structuredClone(s.final);
  before.tracks[0].clips[0].speedCurve[0].optional=undefined;
  before.tracks[0].clips[0].transform.optional=undefined;
  before.audioSelection.optional=undefined;
  before.tracks.find(t=>t.type==='audio').optional=undefined;
  before.assets[0].optional=undefined;
  const persisted=JSON.parse(JSON.stringify(before));
  const reordered=packedFrom(persisted,[s.ids[2],s.ids[0],s.ids[1]]);
  assert.doesNotThrow(()=>assertPreserved(before,reordered,[s.ids[2],s.ids[0],s.ids[1]]));
});
for(const [label,change] of [
  ['null versus absent',p=>{p.captions[0].confidence=null;}],
  ['text',p=>{p.captions[0].text='Changed';}],
  ['timing',p=>{p.captions[0].endMs+=1;}],
  ['ordering',p=>{p.captions.push({...p.captions[0],id:'caption-2'});p.captions.reverse();}],
]) test(`caption preservation rejects ${label} drift`,()=>{
  const {before,ids}=nonzeroFixture(),after=packedFrom(before,[ids[2],ids[0],ids[1]]);change(after);
  assert.throws(()=>assertPreserved(before,after,[ids[2],ids[0],ids[1]]),assert.AssertionError);
});
test('packing accepts zero-origin contiguous reordered clips',()=>{
  const s=setup(),after=packedFrom(s.project,[s.ids[2],s.ids[0],s.ids[1]]);
  after.tracks.find(t=>t.type==='video').clips.forEach((c,i)=>{c.timelineStartMs=[0,10000,20000][i];c.timelineEndMs=[10000,20000,30000][i];});
  assert.doesNotThrow(()=>assertPreserved(s.project,after,[s.ids[2],s.ids[0],s.ids[1]]));
});
test('packing accepts nonzero-origin contiguous reorder and realistic A,B,C to C,A,B with gaps and unequal durations',()=>{
  const {before,ids}=nonzeroFixture(),after=packedFrom(before,[ids[2],ids[0],ids[1]]);
  assert.deepEqual(orderedIds(after),[ids[2],ids[0],ids[1]]);
  assert.equal(after.tracks.find(t=>t.type==='video').clips[0].timelineStartMs,500);
  assert.doesNotThrow(()=>assertPreserved(before,after,[ids[2],ids[0],ids[1]]));
});
function orderedIds(project){return project.tracks.filter(t=>t.type==='video'||t.type==='broll').flatMap(t=>t.clips).sort((a,b)=>a.timelineStartMs-b.timelineStartMs).map(c=>c.id);}
for(const [label,mutate] of [
  ['gap',clips=>{clips[1].timelineStartMs+=1;clips[1].timelineEndMs+=1;clips[2].timelineStartMs+=1;clips[2].timelineEndMs+=1;}],
  ['overlap',clips=>{clips[1].timelineStartMs-=1;clips[1].timelineEndMs-=1;clips[2].timelineStartMs-=1;clips[2].timelineEndMs-=1;}],
]) test(`packing rejects ${label} after reorder`,()=>{
  const {before,ids}=nonzeroFixture(),after=packedFrom(before,[ids[2],ids[0],ids[1]]),clips=after.tracks.find(t=>t.type==='video').clips;
  mutate(clips);assert.throws(()=>assertPreserved(before,after,[ids[2],ids[0],ids[1]]),assert.AssertionError);
});
test('project duration follows deterministic maximum and accepts unchanged duration',()=>{
  const {before,ids}=nonzeroFixture(16000),after=packedFrom(before,[ids[2],ids[0],ids[1]]);
  assert.equal(after.durationMs,16000);assert.equal(expectedReorderedProjectDuration(after,before.durationMs),16000);
  assert.doesNotThrow(()=>assertPreserved(before,after,[ids[2],ids[0],ids[1]]));
});
test('project duration accepts deterministic growth when packed content extends beyond prior duration',()=>{
  const {before,ids}=nonzeroFixture(8000),after=packedFrom(before,[ids[2],ids[0],ids[1]]);
  assert.equal(after.durationMs,9000);assert.ok(after.durationMs>before.durationMs);
  assert.doesNotThrow(()=>assertPreserved(before,after,[ids[2],ids[0],ids[1]]));
});
for(const [label,duration] of [['shrink',7999],['unexplained increase',9001]])test(`project duration rejects ${label}`,()=>{
  const {before,ids}=nonzeroFixture(8000),after=packedFrom(before,[ids[2],ids[0],ids[1]]);after.durationMs=duration;
  assert.throws(()=>assertPreserved(before,after,[ids[2],ids[0],ids[1]]),assert.AssertionError);
});
const structuralDriftCases=[
  ['source range','LIVE_PRESERVE_SOURCE_RANGE',p=>{p.tracks[0].clips[0].sourceInMs+=1;}],
  ['speed','LIVE_PRESERVE_SPEED',p=>{p.tracks[0].clips[0].speedCurve[0].rate+=1;}],
  ['transform','LIVE_PRESERVE_TRANSFORM',p=>{p.tracks[0].clips[0].transform.scale+=1;}],
  ['asset binding','LIVE_PRESERVE_BINDINGS',p=>{p.tracks[0].clips[0].assetId='different';}],
  ['audio selection','LIVE_PRESERVE_AUDIO_SELECTION',p=>{p.audioSelection.mode='range';}],
  ['audio track','LIVE_PRESERVE_AUDIO_TRACKS',p=>{p.tracks.find(t=>t.type==='audio').clips.push({id:'extra-audio',timelineStartMs:0,timelineEndMs:100});}],
  ['assets collection','LIVE_PRESERVE_ASSETS',p=>{p.assets.pop();}],
];
for(const [label,expected,change] of structuralDriftCases)test(`meaningful ${label} drift fails at ${expected}`,()=>{
  const s=setup(),after=structuredClone(s.final);change(after);
  let substage;assert.throws(()=>assertPreserved(s.project,after,[s.ids[2],s.ids[0],s.ids[1]],value=>{substage=value;}),assert.AssertionError);
  assert.equal(substage,expected);
});
test('every preservation substage propagates through outer gateScope, SafeAcceptanceGateError, safeError and formatter',async()=>{
  const cases=[
    ['LIVE_PRESERVE_IDENTITY',p=>{p.tracks[0].clips[0].id='wrong-id';}],
    ...structuralDriftCases.map(([,stage,change])=>[stage,change]),
    ['LIVE_PRESERVE_DURATION',p=>{p.tracks[0].clips[0].timelineEndMs+=1;}],
    ['LIVE_PRESERVE_TIMELINE_PACKING',p=>{p.tracks[0].clips[0].timelineStartMs+=1;p.tracks[0].clips[0].timelineEndMs+=1;}],
    ['LIVE_PRESERVE_PROJECT_DURATION',p=>{p.durationMs+=1;}],
    ['LIVE_PRESERVE_CAPTIONS',p=>{p.captions[0].text='Changed';}],
  ];
  for(const [expected,change] of cases){
    const s=setup(),after=structuredClone(s.final);change(after);
    await assert.rejects(gateScope('LIVE_ACCEPTANCE',async(_stage,setSubstage)=>{
      setSubstage('LIVE_FINAL_PRESERVATION');assertPreserved(s.project,after,[s.ids[2],s.ids[0],s.ids[1]],setSubstage);
    }),error=>{
      assert.equal(error.gate,'LIVE_ACCEPTANCE');assert.equal(error.code,'ASSERTION_FAILED');assert.equal(error.substage,expected);
      assert.match(formatAcceptanceFailure(error,false),new RegExp(`SUBSTAGE = ${expected}`));return true;
    });
  }
});
test('an error before classified checks retains the safe generic preservation wrapper',async()=>{
  const s=setup();
  await assert.rejects(gateScope('LIVE_ACCEPTANCE',async(_stage,setSubstage)=>{
    setSubstage('LIVE_FINAL_PRESERVATION');assertPreserved(s.project,{tracks:null},s.ids);
  }),error=>{assert.equal(error.substage,'LIVE_FINAL_PRESERVATION');assert.match(formatAcceptanceFailure(error,false),/SUBSTAGE = LIVE_FINAL_PRESERVATION/);return true;});
});
test('response observer failure during gate blocks before submit',async()=>{const s=setup();s.adapter.harness.waitForResponse=async()=>{throw Error('observer failed');};await assert.rejects(runReorderAcceptance(['--mode=live'],allow,s.adapter),{gate:'LIVE_ACCEPTANCE',code:'ASSERTION_FAILED'});assert.equal(s.clicks(),0);});
