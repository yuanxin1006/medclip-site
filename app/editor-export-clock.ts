/** Integer output time is independent of browser playback and wall-clock time. */
export type ExportSegment = { start:number; end:number; assetId:string; layer?:number; sourceStart?:number; sourceEnd?:number; playbackRate?:number; speedCurve?:{at:number;rate:number}[] };
export function exportSegmentIndexAt(segments:readonly ExportSegment[],time:number){
 let active=-1;
 segments.forEach((s,i)=>{if(time>=s.start&&time<s.end&&(active<0||(s.layer??0)>=(segments[active].layer??0)))active=i;});
 return active;
}
export function exportFrameTimes(duration:number,segments:readonly ExportSegment[],extra:number[]=[],fps=30){
 const end=Math.round(duration*1e6),points=new Set<number>([0,end]);
 for(let n=1;n/fps<duration;n++)points.add(Math.round(n/fps*1e6));
 for(const s of segments)for(const t of[s.start,s.end])if(t>0&&t<duration)points.add(Math.round(t*1e6));
 for(const t of extra)if(t>0&&t<duration)points.add(Math.round(t*1e6));
 return [...points].sort((a,b)=>a-b);
}
export function exportVisibleSpans(segments:readonly ExportSegment[],duration:number){
 const edges=[...new Set([0,duration,...segments.flatMap(s=>[Math.max(0,s.start),Math.min(duration,s.end)])])].filter(x=>x>=0&&x<=duration).sort((a,b)=>a-b);
 return edges.slice(0,-1).map((start,i)=>({start,end:edges[i+1],index:exportSegmentIndexAt(segments,(start+edges[i+1])/2)})).filter(s=>s.end>s.start);
}
export function exportHasUnitSpeed(s:ExportSegment){
 return Math.abs((s.playbackRate??1)-1)<1e-9&&(!s.speedCurve?.length||s.speedCurve.every(p=>Math.abs(p.rate-1)<1e-9))
  &&(s.sourceEnd===undefined||Math.abs(s.sourceEnd-(s.sourceStart??0)-(s.end-s.start))<.0011);
}
export function exportSampleRange(start:number,end:number,rate:number){return{start:Math.round(start*rate),end:Math.round(end*rate)};}