import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { formatPositionScaleFailure, PositionScaleGateError, POSITION_SCALE_FIXTURE_REASON, POSITION_SCALE_SUBSTAGES } from './video-ai-position-scale-diagnostics.mjs';
import { EXPECTED_AI_TASKS_VERSION } from './video-ai-reorder-identity.mjs';

export const EXPECTED_POSITION_SCALE = Object.freeze({ type:'SET_CLIP_POSITION_SCALE', assetId:'', x:25, y:-25, scale:0.8 });
export const POSITION_SCALE_REQUIREMENT = '把第三个视频缩小到80%，放到右上角。';
export const POSITION_SCALE_ACTION = Object.freeze({ type:'SET_CLIP_POSITION_SCALE', assetId:'', x:25, y:-25, scale:0.8, reason:POSITION_SCALE_FIXTURE_REASON });

export function eligibleClips(project) {
  return project.tracks.filter(track => ['video','broll'].includes(track.type)).flatMap(track => track.clips)
    .sort((a,b) => a.timelineStartMs-b.timelineStartMs);
}
export function transformOf(clip) { return { x:clip.transform.x, y:clip.transform.y, scale:clip.transform.scale }; }
export const POSITION_SCALE_ACTION_KEYS = Object.freeze(['type','targetId','assetId','x','y','scale','reason']);
export function assertPositionScaleAction(action, targetId) {
  assert.equal(typeof targetId,'string');
  assert.ok(targetId.trim());
  assert.ok(action && typeof action==='object' && !Array.isArray(action));
  assert.deepEqual(Object.keys(action).sort(),[...POSITION_SCALE_ACTION_KEYS].sort());
  assert.deepEqual(action, { ...POSITION_SCALE_ACTION, targetId });
}
export function createPositionScaleAction(targetId) {
  const action={...POSITION_SCALE_ACTION,targetId};
  assertPositionScaleAction(action,targetId);
  return action;
}
export function assertPositionScalePreserved(before, after, targetId, expectedTransform) {
  const oldClips = eligibleClips(before), newClips = eligibleClips(after);
  assert.equal(oldClips.length,3); assert.equal(newClips.length,3);
  assert.equal(new Set(newClips.map(c=>c.id)).size,3);
  assert.deepEqual(newClips.map(c=>c.id),oldClips.map(c=>c.id));
  for (let i=0;i<oldClips.length;i++) {
    const a=oldClips[i],b=newClips[i];
    assert.equal(a.id,b.id); assert.equal(a.assetId,b.assetId); assert.equal(a.trackId,b.trackId);
    assert.equal(a.sourceInMs,b.sourceInMs); assert.equal(a.sourceOutMs,b.sourceOutMs);
    assert.equal(a.timelineStartMs,b.timelineStartMs); assert.equal(a.timelineEndMs,b.timelineEndMs);
    assert.deepEqual(b.speedCurve,a.speedCurve); assert.equal(b.playbackRate,a.playbackRate);
    if(a.id!==targetId) assert.deepEqual(transformOf(b),transformOf(a));
    assert.equal(b.transform.crop,a.transform.crop); assert.equal(b.transform.fit,a.transform.fit);
  }
  assert.deepEqual(after.tracks.filter(t=>t.type==='audio'),before.tracks.filter(t=>t.type==='audio'));
  assert.deepEqual(after.audioSelection,before.audioSelection);
  assert.deepEqual(after.captions,before.captions);
  assert.deepEqual(after.assets,before.assets);
  assert.equal(after.ratio,before.ratio); assert.equal(after.durationMs,before.durationMs);
  const target=newClips.find(c=>c.id===targetId); assert.ok(target);
  assert.deepEqual(transformOf(target),expectedTransform);
}
export function assertFixtureProject(project, ids, assetIds) {
  const clips=eligibleClips(project);
  assert.equal(clips.length,3); assert.deepEqual(clips.map(c=>c.id),ids);
  assert.deepEqual(clips.map(c=>c.assetId),assetIds);
  assert.ok(clips.every(c=>c.transform && c.transform.x===0 && c.transform.y===0 && c.transform.scale===1));
}
export function assertHistoryState(project, reference, targetId, transform) {
  assertPositionScalePreserved(reference,project,targetId,transform);
}
export function assertProviderCounts(counts) {
  for (const name of ['remote','deepseek','kimi','doubao','tokenhub']) assert.equal(counts[name] ?? 0,0);
}
const METADATA_FAILURE_STAGES=new Set(['POSITION_SCALE_REMOTE_METADATA_EXEC','POSITION_SCALE_REMOTE_METADATA_PARSE','POSITION_SCALE_REMOTE_STATUS','POSITION_SCALE_REMOTE_VERSION']);
export async function verifyPositionScaleRemoteMetadata(adapter, provenance) {
  let remote;
  try { remote=await adapter.remoteMetadata(); }
  catch(error) {
    const substage=METADATA_FAILURE_STAGES.has(error?.substage) ? error.substage : 'POSITION_SCALE_REMOTE_METADATA_EXEC';
    throw new PositionScaleGateError(substage,provenance);
  }
  if(!remote || typeof remote!=='object' || typeof remote.version!=='number' || !Number.isSafeInteger(remote.version)
    || typeof remote.status!=='string') throw new PositionScaleGateError('POSITION_SCALE_REMOTE_METADATA_PARSE',provenance);
  if(remote.status!=='ACTIVE') throw new PositionScaleGateError('POSITION_SCALE_REMOTE_STATUS',provenance);
  if(remote.version!==EXPECTED_AI_TASKS_VERSION) throw new PositionScaleGateError('POSITION_SCALE_REMOTE_VERSION',provenance);
  return remote;
}
export function safeIdentity() {
  const cwd=process.cwd();
  return { pid:process.pid,cwd,gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim() };
}
export async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }

export async function runPositionScalePreflight(args=process.argv.slice(2), env=process.env, adapterFactory) {
  let stage='POSITION_SCALE_EDITOR_LOAD', adapter, provenance, failure;
  try {
    assert.deepEqual(args,['--mode=preflight']);
    const { createPositionScaleAdapter } = adapterFactory ? {createPositionScaleAdapter:adapterFactory}
      : await import('./video-ai-position-scale-browser-adapter.mjs');
    adapter=await createPositionScaleAdapter(env);
    provenance=await adapter.provenance();
    assert.ok(provenance.pid && provenance.cwd && provenance.gitHead && provenance.hashes?.runner && provenance.hashes?.browserAdapter && provenance.hashes?.diagnostics);
    stage='POSITION_SCALE_REMOTE_VERSION';
    const remote=await verifyPositionScaleRemoteMetadata(adapter,provenance);
    stage='POSITION_SCALE_EDITOR_LOAD';
    await adapter.armProviderGuard();
    stage='POSITION_SCALE_AUTH';
    const session=await adapter.authenticate();
    stage='POSITION_SCALE_EDITOR_LOAD';
    const editor=await adapter.openEditor(session,substage=>{
      if(POSITION_SCALE_SUBSTAGES.includes(substage)) stage=substage;
    });
    stage='POSITION_SCALE_OWNED_FIXTURE';
    const fixture=await adapter.fixture(substage => {
      if (POSITION_SCALE_SUBSTAGES.includes(substage)) stage=substage;
    });
    stage='POSITION_SCALE_SAFE_CONTEXT';
    const ids=fixture.clipIds; const targetId=ids[2];
    assert.deepEqual(ids,fixture.expectedClipIds);
    assertFixtureProject(fixture.project,ids,fixture.assetIds);
    assert.deepEqual(fixture.contextOrder,['A','B','C']);
    assert.deepEqual(fixture.contextTransform,{x:0,y:0,scale:1});
    stage='POSITION_SCALE_ACTION_FIXTURE_SHAPE';
    const action=createPositionScaleAction(targetId);
    stage='POSITION_SCALE_FIXTURE_BASELINE';
    const initialState=await adapter.captureProject();
    assert.deepEqual(initialState,fixture.project);
    stage='POSITION_SCALE_ACTION_TARGET';
    await adapter.applyCanonicalAction(action,POSITION_SCALE_REQUIREMENT,substage=>{
      if(POSITION_SCALE_SUBSTAGES.includes(substage)) stage=substage;
    });
    stage='POSITION_SCALE_FINAL_TRANSFORM';
    const after=await adapter.captureProject();
    assert.deepEqual(transformOf(eligibleClips(after)[2]),{x:25,y:-25,scale:0.8});
    stage='POSITION_SCALE_PRESERVATION';
    assertPositionScalePreserved(fixture.project,after,targetId,{x:25,y:-25,scale:0.8});
    stage='POSITION_SCALE_PREVIEW';
    await adapter.assertPreview(after,targetId);
    stage='HISTORY_PRE_EDIT_SNAPSHOT';
    stage='HISTORY_UNDO_RESULT';
    const undoObservation=await adapter.undo(substage=>{
      if(POSITION_SCALE_SUBSTAGES.includes(substage)) stage=substage;
    });
    const undone=await adapter.captureProject();
    assertHistoryState(undone,fixture.project,targetId,{x:0,y:0,scale:1});
    assert.deepEqual(undoObservation,{ui:{x:0,y:0,scale:1},preview:{x:0,y:0,scale:1}});
    stage='HISTORY_REDO_CONTROL_FOUND';
    const redoObservation=await adapter.redo(substage=>{
      if(POSITION_SCALE_SUBSTAGES.includes(substage)) stage=substage;
    });
    const redone=await adapter.captureProject();
    stage='HISTORY_REDO_RESULT';
    assertHistoryState(redone,fixture.project,targetId,{x:25,y:-25,scale:0.8});
    assert.deepEqual(redoObservation,{ui:{x:25,y:-25,scale:0.8},preview:{x:25,y:-25,scale:0.8}});
    stage='POSITION_SCALE_PERSISTENCE';
    await adapter.assertPersistence(redone,targetId);
    stage='POSITION_SCALE_EXPORT';
    await adapter.assertRenderPlan(redone,targetId);
    stage='POSITION_SCALE_PROVIDER_COUNT';
    const counts=await adapter.providerCounts(); assertProviderCounts(counts);
    return {result:'PREFLIGHT_PASS',providerCalls:0,remoteVersion:remote.version,remoteStatus:remote.status,sourceIdentity:'PASS',
      editorHttp:editor.httpStatus,browserLaunch:'PASS',safeContextOrder:'A,B,C',target:'C',x:25,y:-25,scale:0.8,
      undo:{controlFound:true,controlEnabled:true,result:'PASS',...undoObservation},
      redo:{controlFound:true,controlEnabled:true,result:'PASS',...redoObservation},
      postRedoPreservation:'PASS',persistence:'PASS',exportRender:'PASS',providerCounts:counts,provenance};
  } catch(error) {
    if(error instanceof PositionScaleGateError) {
      failure=!error.provenance && provenance
        ? new PositionScaleGateError(error.substage ?? stage,provenance,error.observedPreview) : error;
    } else {
      failure=new PositionScaleGateError(stage,provenance);
    }
    throw failure;
  }
  finally {
    if(adapter) {
      try { await adapter.close(); }
      catch { if(!failure) throw new PositionScaleGateError(stage,provenance); }
    }
  }
}

export async function runPositionScaleCLI(args, env, output=console) {
  try { const result=await runPositionScalePreflight(args,env); output.log(JSON.stringify(result)); return 0; }
  catch(error) { output.error(formatPositionScaleFailure(error)); return 1; }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) process.exitCode=await runPositionScaleCLI(process.argv.slice(2),process.env);
