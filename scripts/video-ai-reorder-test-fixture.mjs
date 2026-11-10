import assert from 'node:assert/strict';
import { createSafeEditorAIContext, applyAIEditingPlan } from '../app/editor-ai-requirements.ts';
import { createInternalTextTaskFixtureApplicationContext } from '../supabase/functions/_shared/ai-tasks/text-fixtures.ts';
import { summarizeAITaskResponse } from './video-ai-live-acceptance-harness.ts';
import { REORDER_REQUIREMENT } from './run-video-ai-reorder-live-acceptance.mjs';
import { EXPECTED_AI_TASKS_VERSION } from './video-ai-reorder-identity.mjs';
export function setup() {
  const { project } = createInternalTextTaskFixtureApplicationContext('valid_reorder_c_before_a');
  project.captions = [{id:'caption',text:'Unchanged subtitle',startMs:0,endMs:1000}];
  const ids = project.tracks.flatMap(t=>t.clips).map(c=>c.id);
  const owned = new Set(project.assets.map(a=>a.id));
  const target = project.tracks.flatMap(t=>t.clips).find(c=>c.id===ids[2]);
  const input = { serializedContext:createSafeEditorAIContext(project, owned, project.audioSelection.sourceDurationMs),
    expectedClipId:ids[2], expectedAssetId:target.assetId, expectedTargetClipId:ids[2], expectedReferenceClipId:ids[0], expectedClipIds:ids };
  const plan = { summary:'Reorder', actions:[{ type:'REORDER_CLIP', targetId:ids[2], referenceId:ids[0], placement:'BEFORE', assetId:'', reason:'test' }], warnings:[], unsupported:[] };
  let state = project, clicks = 0, closed = false;
  const events = [];
  const final = applyAIEditingPlan(plan, { project, ownedAssetIds:owned, audioSourceDurationMs:project.audioSelection.sourceDurationMs }).project;
  const response = summarizeAITaskResponse(200,true,{ok:true,requestId:'mock-request',result:{data:plan}});
  const adapter = {
    reachability:async()=>{}, authenticate:async()=>{}, identity:async()=>({version:EXPECTED_AI_TASKS_VERSION,hashMismatches:0,fileCount:5}),
    smoke:async()=>({pass:true,providerCalls:0}), openEditor:async()=>{}, fixture:async()=>({project,preLiveContext:input}),
    prepareRequirement:async value=>assert.equal(value,REORDER_REQUIREMENT),
    readSafeContext:async()=>{events.push('context');return input;},
    harness:{timeoutMs:50,getRequestCount:()=>clicks,waitForResponse:async()=>{events.push('observer');return response;},
      submitOnce:async()=>{events.push('submit');clicks++;state=final;},
      readEditorSurface:async()=>({successVisible:true,successText:'applied',errorVisible:false,errorText:''}),
      captureEditorState:async()=>state},
    assertPreviewAndExport:async order=>assert.deepEqual(state.tracks.flatMap(t=>t.clips).map(c=>c.id),order),
    undo:async()=>{state=project;},redo:async()=>{state=final;},captureProject:async()=>state,
    close:async()=>{closed=true;},
  };
  return {adapter,input,project,final,ids,plan,response,events,clicks:()=>clicks,closed:()=>closed};
}
