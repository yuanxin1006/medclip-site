import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {collectCurrentVideoEvidence,TWO_STAGE_LOCAL_ANALYSIS_VERSION} from './editor-video-analysis.ts';
import {LOCAL_CLIP_ANALYSIS_VERSION,VideoSemanticAnalysisCache} from './editor-video-semantic.ts';
import {inspectEditorVisualContext,editorVisualContextMessage} from './editor-visual-readiness.ts';
import {createSafeEditorAIContext} from './editor-ai-requirements.ts';
import {createFullAudioSelection,DEFAULT_TRANSFORM,DEFAULT_SPEED_CURVE,type EditorProject} from './editor-core.ts';
import {deriveEditorCaptionConceptsV1} from './editor-caption-concepts.ts';
// Contract fixtures below test plumbing and safety only; they are not visual inference evidence.
function project():EditorProject {return {schemaVersion:2,id:'contract-project',title:'contract only',updatedAt:'2026-11-07T00:00:00.000Z',durationMs:10000,ratio:'16:9',audioSelection:createFullAudioSelection(10000),assets:[{id:'asset-a',name:'untrusted-name.mp4',kind:'视频',durationMs:10000}],tracks:[{id:'video-main',type:'video',name:'video',clips:[{id:'clip-a',assetId:'asset-a',name:'untrusted-name.mp4',kind:'视频',trackId:'video-main',timelineStartMs:0,timelineEndMs:10000,sourceInMs:0,sourceOutMs:10000,transform:{...DEFAULT_TRANSFORM},speedCurve:DEFAULT_SPEED_CURVE.map(x=>({...x}))}]}],captions:[{id:'cue-a',text:'问诊',startMs:1000,endMs:3000}]};}
function analysis(version:string,method:'local-clip'|'filename-fallback'='local-clip'){return {schemaVersion:1 as const,assetId:'asset-a',assetDurationMs:10000,analysisVersion:version,analysisMethod:method,createdAt:'2026-11-07T00:00:00.000Z',segments:[{id:'segment-a',assetId:'asset-a',startMs:0,endMs:10000,summary:'unit contract fixture',concepts:['医生问诊'],usability:.5,confidence:.9,evidenceFrameMs:[1000,5000]}]};}
test('two-stage writer output is readable at the formal planner handoff',()=>{const c=new VideoSemanticAnalysisCache();const a=c.set(analysis(TWO_STAGE_LOCAL_ANALYSIS_VERSION));assert.deepEqual(collectCurrentVideoEvidence(c,project().assets),[a]);});
test('two-stage evidence takes precedence over compatible legacy evidence',()=>{const c=new VideoSemanticAnalysisCache();c.set(analysis(LOCAL_CLIP_ANALYSIS_VERSION));const a=c.set(analysis(TWO_STAGE_LOCAL_ANALYSIS_VERSION));assert.deepEqual(collectCurrentVideoEvidence(c,project().assets),[a]);});
test('legacy real analysis remains readable for backward compatibility',()=>{const c=new VideoSemanticAnalysisCache();const a=c.set(analysis(LOCAL_CLIP_ANALYSIS_VERSION));assert.deepEqual(collectCurrentVideoEvidence(c,project().assets),[a]);});
test('filename fallback is never promoted to real frame evidence',()=>{const c=new VideoSemanticAnalysisCache();c.set(analysis(LOCAL_CLIP_ANALYSIS_VERSION,'filename-fallback'));c.set(analysis(TWO_STAGE_LOCAL_ANALYSIS_VERSION,'filename-fallback'));assert.deepEqual(collectCurrentVideoEvidence(c,project().assets),[]);});
test('stale duration, unknown model version and a different asset cannot reuse evidence',()=>{const c=new VideoSemanticAnalysisCache();c.set(analysis(TWO_STAGE_LOCAL_ANALYSIS_VERSION));c.set(analysis('unknown-version'));assert.deepEqual(collectCurrentVideoEvidence(c,[{id:'asset-a',durationMs:9999},{id:'other-asset',durationMs:10000}]),[]);const other=new VideoSemanticAnalysisCache();other.set(analysis('unknown-version'));assert.deepEqual(collectCurrentVideoEvidence(other,project().assets),[]);});
test('caption-only transcription placeholder is not an actionable timeline',()=>{const p=project();p.tracks[0].clips=[];const before=JSON.stringify(p);const r=inspectEditorVisualContext(p,new Set(['asset-a']));assert.equal(r.status,'NO_TIMELINE_CLIPS');assert.equal(r.actionableClipCount,0);assert.match(editorVisualContextMessage(r.status),/建立时间线/);assert.equal(JSON.stringify(p),before);});
test('a partially linked timeline cannot shift ordinal AI targets',()=>{const p=project();p.tracks[0].clips.push({...p.tracks[0].clips[0],id:'unlinked',assetId:'missing'});const r=inspectEditorVisualContext(p,new Set(['asset-a']));assert.equal(r.status,'MEDIA_NOT_AVAILABLE');assert.equal(r.actionableClipCount,1);});
test('restored timeline without relinked current-session ownership is blocked',()=>{const r=inspectEditorVisualContext(project(),new Set());assert.equal(r.status,'MEDIA_NOT_AVAILABLE');assert.equal(r.timelineClipCount,1);assert.match(editorVisualContextMessage(r.status),/重新关联/);});
test('kind or track mismatch cannot be turned into an actionable clip',()=>{const p=project();p.assets[0].kind='图片';assert.equal(inspectEditorVisualContext(p,new Set(['asset-a'])).status,'MEDIA_NOT_AVAILABLE');p.assets[0].kind='视频';p.tracks[0].clips[0].trackId='wrong-track';assert.equal(inspectEditorVisualContext(p,new Set(['asset-a'])).status,'MEDIA_NOT_AVAILABLE');});
test('real visual timeline context is preserved without changing captions',()=>{const p=project(),before=JSON.stringify(p);assert.equal(inspectEditorVisualContext(p,new Set(['asset-a'])).status,'READY');assert.equal(JSON.parse(createSafeEditorAIContext(p,new Set(['asset-a']),10000)).clips.length,1);assert.equal(JSON.stringify(p),before);});
test('physical examination and consultation remain independent semantic targets',()=>{const cues=[{id:'exam',text:'用心查体，为爱坚守',startMs:58380,endMs:69340},{id:'history',text:'问诊先把主诉理清',startMs:0,endMs:22960}];const before=JSON.stringify(cues),out=deriveEditorCaptionConceptsV1(cues);assert.ok(out[0].concepts.includes('体格检查'));assert.ok(out[1].concepts.includes('医生问诊'));assert.equal(JSON.stringify(cues),before);});
test('unsupported lyrics do not acquire invented semantic concepts',()=>{assert.deepEqual(deriveEditorCaptionConceptsV1([{id:'empty',text:'……',startMs:0,endMs:2000}])[0].concepts,[]);});

test('scoped lyrics keep the full project identity and require exact target boundaries',async()=>{
 const {generateEditorProposal}=await import('./editor-proposal-orchestrator.ts');
 const {createEditorProjectFingerprint}=await import('./editor-plan-evidence.ts');
 const p=project();p.captions.push({id:'cue-b',text:'问诊',startMs:5000,endMs:7000});
 const input={project:p,videoAnalyses:[analysis(LOCAL_CLIP_ANALYSIS_VERSION)],captionConcepts:deriveEditorCaptionConceptsV1(p.captions)};
 const rejected=generateEditorProposal({...input,captionScopeIds:['cue-a']});
 assert.equal(rejected.status,'SOURCE_RANGE_UNSUPPORTED');
 const clip=p.tracks[0].clips[0];clip.timelineStartMs=1000;clip.timelineEndMs=3000;clip.sourceOutMs=2000;
 const accepted=generateEditorProposal({...input,captionScopeIds:['cue-a']});
 assert.equal(accepted.ok,true);
 if(accepted.ok){assert.equal(accepted.bundle.sourceProjectFingerprint,createEditorProjectFingerprint(p));assert.equal(accepted.bundle.trustedPreExecutionProject.captions.length,2);assert.equal(accepted.bundle.matchingIntervals.length,1);}
 assert.equal(generateEditorProposal({...input,captionScopeIds:['missing']}).status,'MISSING_INTERVALS');
});
