import assert from "node:assert/strict";
import test from "node:test";
import {appendOwnedVisualAsset,validateVisualRelink,friendlyEditingError} from "./editor-workflow.ts";
import {DEFAULT_TRANSFORM,DEFAULT_SPEED_CURVE,createFullAudioSelection,type EditorProject} from "./editor-core.ts";
import {guardManualTimelineMutationV1} from "./editor-manual-constraint-guard.ts";
function project():EditorProject{return{schemaVersion:2,id:"workflow-test",title:"manual contract",updatedAt:"2026-11-08T00:00:00.000Z",durationMs:2000,ratio:"16:9",audioSelection:createFullAudioSelection(2000),assets:[{id:"a",name:"a.mp4",kind:"视频",durationMs:2000}],tracks:[{id:"video-main",type:"video",name:"主视频",clips:[{id:"clip-a",assetId:"a",name:"a.mp4",kind:"视频",trackId:"video-main",timelineStartMs:0,timelineEndMs:2000,sourceInMs:0,sourceOutMs:2000,transform:{...DEFAULT_TRANSFORM},speedCurve:DEFAULT_SPEED_CURVE.map(p=>({...p}))}]}],captions:[{id:"cue",text:"manual fixture",startMs:100,endMs:1800}]};}
test("adding an owned unused asset appends without moving existing clips or captions",()=>{
 const p=project(),before=JSON.stringify(p),owned=[...p.assets,{id:"b",name:"b.mp4",kind:"视频" as const,durationMs:1000}],next=appendOwnedVisualAsset(p,owned,"b","clip-b");
 assert.equal(JSON.stringify(p),before);assert.deepEqual(next.tracks[0].clips[0],p.tracks[0].clips[0]);assert.deepEqual(next.captions,p.captions);
 assert.equal(next.tracks[0].clips[1].timelineStartMs,2000);assert.equal(next.tracks[0].clips[1].timelineEndMs,3000);assert.equal(next.durationMs,3000);assert.equal(next.assets.length,2);
 assert.equal(guardManualTimelineMutationV1({currentProject:p,candidateProject:next}).status,"ALLOWED");
});
test("unowned, invalid and colliding additions are rejected",()=>{
 const p=project();assert.throws(()=>appendOwnedVisualAsset(p,[],"a","x"));
 assert.throws(()=>appendOwnedVisualAsset(p,p.assets,"a","clip-a"));
 assert.throws(()=>appendOwnedVisualAsset(p,[{...p.assets[0],durationMs:0}],"a","x"));
});
test("explicit media relinking rejects mismatched names, types or durations",()=>{
 const a=project().assets[0];assert.doesNotThrow(()=>validateVisualRelink(a,{name:a.name,kind:a.kind,durationMs:2001}));
 assert.throws(()=>validateVisualRelink(a,{name:"other.mp4",kind:a.kind,durationMs:2000}));
 assert.throws(()=>validateVisualRelink(a,{name:a.name,kind:"图片",durationMs:2000}));
 assert.throws(()=>validateVisualRelink(a,{name:a.name,kind:a.kind,durationMs:2200}));
});
test("workflow messages explain missing timelines and uncertain matches in user language",()=>{
 assert.match(friendlyEditingError({status:"NO_VALID_CANDIDATE",message:"canonical editorContext"}),/无法可靠判断/);
 assert.doesNotMatch(friendlyEditingError({status:"OTHER",message:"editorContext clips schema error"}),/editorContext|schema/);
});
