import test from "node:test";
import assert from "node:assert/strict";
import {parseEditorProject,createFullAudioSelection} from "./editor-core.ts";
import {activeCaptionAt,captionTimelineHasOverlap,drawEditorCaptionAt,type CaptionCanvasContext} from "./editor-captions.ts";
import {applyReferenceTranscript} from "./transcription-core.ts";
test("subtitle restore preserves overlapping valid IDs, texts and exact source times",()=>{
 const cues=[{id:"long",text:"reference",startMs:0,endMs:60000},{id:"a",text:"accurate A",startMs:1000,endMs:3000},{id:"b",text:"accurate B",startMs:4000,endMs:6000}];
 const raw={schemaVersion:2,id:"test",title:"test",durationMs:60000,ratio:"16:9",assets:[],tracks:[],captions:cues,audioSelection:createFullAudioSelection(60000)};
 const actual=parseEditorProject(JSON.stringify(raw));
 assert.deepEqual(actual?.captions,cues);
 assert.equal(captionTimelineHasOverlap(actual!.captions),true);
 assert.equal(activeCaptionAt(actual!.captions,1500)?.id,"a");
 assert.equal(activeCaptionAt(actual!.captions,4500)?.id,"b");
 assert.equal(activeCaptionAt(actual!.captions,60000),undefined);
});
test("caption burn retains every character beyond 80 and uses multiline layout without retiming",()=>{
 const text="保留完整文字不截断".repeat(20),cue={id:"long",text,startMs:100,endMs:2000};
 const rendered:string[]=[];const context={save(){},restore(){},fillText(text:string){rendered.push(text)},strokeText(){},measureText(text:string){return{width:Array.from(text).length*20}},font:"",globalAlpha:1,lineWidth:0,strokeStyle:"",fillStyle:"",textAlign:"center",textBaseline:"middle"} as unknown as CaptionCanvasContext;
 assert.equal(drawEditorCaptionAt(context,[cue],500,1080,1920),cue);
 assert.ok(rendered.length>1);assert.equal(rendered.join(""),text);assert.deepEqual([cue.startMs,cue.endMs],[100,2000]);
});
test("an unmatched reference paragraph never replaces a small set of timed speech",()=>{
 const original=[{id:"asr",text:"这一句",startMs:100,endMs:3000}];
 const result=applyReferenceTranscript(original,"完整歌词没有对应时间码".repeat(30));
 assert.equal(result[0].text,original[0].text);assert.deepEqual([result[0].startMs,result[0].endMs],[100,3000]);assert.equal(result[0].recognizedText,"这一句");assert.equal(result[0].needsReview,true);
});
test("reference corrections follow textual correspondence rather than proportional allocation",()=>{
 const original=[{id:"a",text:"阿斯匹林用于部分患者。",startMs:100,endMs:2800},{id:"b",text:"BRCA一基因需要专业解读。",startMs:3200,endMs:6100}];
 const result=applyReferenceTranscript(original,"阿司匹林用于部分患者。BRCA1基因需要专业解读。");
 assert.deepEqual(result.map(c=>[c.startMs,c.endMs]),[[100,2800],[3200,6100]]);
 assert.equal(result.map(c=>c.text).join(""),"阿司匹林用于部分患者。BRCA1基因需要专业解读。");
 assert.deepEqual(result.map(c=>c.recognizedText),original.map(c=>c.text));
});
