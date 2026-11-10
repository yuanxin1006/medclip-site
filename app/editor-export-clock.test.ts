import test from 'node:test';
import assert from 'node:assert/strict';
import {exportFrameTimes,exportSegmentIndexAt,exportVisibleSpans,exportHasUnitSpeed,exportSampleRange} from './editor-export-clock.ts';
const segments=[{assetId:'a',start:0,end:1.76,sourceStart:0,sourceEnd:1.76},{assetId:'a',start:1.76,end:3.52,sourceStart:3.52,sourceEnd:5.28},{assetId:'a',start:3.52,end:5.28,sourceStart:1.76,sourceEnd:3.52},{assetId:'b',start:5.28,end:7.04,sourceStart:0,sourceEnd:1.76}];
test('reordered clips use half-open output boundaries, independently of source order',()=>{
 assert.equal(exportSegmentIndexAt(segments,1.759999),0);assert.equal(exportSegmentIndexAt(segments,1.76),1);assert.equal(exportSegmentIndexAt(segments,3.52),2);assert.equal(exportSegmentIndexAt(segments,7.04),-1);
});
test('all adjacent PCM intervals cover exactly the requested samples with no duplicate boundary sample',()=>{
 const ranges=segments.map(s=>exportSampleRange(s.start,s.end,48000));assert.equal(ranges[0].start,0);assert.equal(ranges.at(-1)!.end,337920);ranges.slice(1).forEach((r,i)=>assert.equal(r.start,ranges[i].end));assert.equal(ranges.reduce((n,r)=>n+r.end-r.start,0),337920);
});
test('cut and subtitle timestamps stay exact instead of being snapped to a nominal frame grid',()=>{
 const points=exportFrameTimes(7.04,[{assetId:'a',start:0,end:1.137},{assetId:'b',start:1.137,end:7.04}],[.501,2.499]);for(const value of[0,501000,1137000,2499000,7040000])assert.ok(points.includes(value));assert.equal(points.at(-1),7040000);points.slice(1).forEach((t,i)=>assert.ok(t>points[i]));
});
test('only the visible clip owns original audio when visual tracks overlap',()=>{
 const s=[{assetId:'base',start:0,end:4,layer:0},{assetId:'upper',start:1,end:3,layer:1},{assetId:'top',start:2,end:2.5,layer:2}];assert.deepEqual(exportVisibleSpans(s,4),[{start:0,end:1,index:0},{start:1,end:2,index:1},{start:2,end:2.5,index:2},{start:2.5,end:3,index:1},{start:3,end:4,index:0}]);
});
test('unsupported original-audio tempo is rejected without changing the source speed contract',()=>{
 const clip={assetId:'a',start:0,end:2,sourceStart:0,sourceEnd:4,speedCurve:[{at:0,rate:2},{at:1,rate:2}]};const before=JSON.stringify(clip);assert.equal(exportHasUnitSpeed(clip),false);assert.equal(JSON.stringify(clip),before);assert.equal(exportHasUnitSpeed(segments[0]),true);
});
test('frame scheduling does not fabricate source frames for an intentional empty timeline interval',()=>{
 const s=[{assetId:'a',start:0,end:1},{assetId:'b',start:2,end:3}];assert.equal(exportSegmentIndexAt(s,1.5),-1);assert.deepEqual(exportVisibleSpans(s,3),[{start:0,end:1,index:0},{start:1,end:2,index:-1},{start:2,end:3,index:1}]);
});