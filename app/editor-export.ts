import {stretchExportPcm} from "./editor-export-stretch";
import {exportFrameTimes,exportSegmentIndexAt,exportVisibleSpans,exportHasUnitSpeed,type ExportSegment} from './editor-export-clock';
import {loadExportMedia,openExportMedia,pcmAtOutputRate,type ExportMedia} from './editor-export-media';
import type {VideoSample} from './vendor/mediabunny';
export type ExportDrawing={width:number;height:number;draw:(context:CanvasRenderingContext2D,x:number,y:number,width:number,height:number)=>void};
type Options={canvas:HTMLCanvasElement;segments:ExportSegment[];assets:{id:string;name:string;kind:string;preview?:string}[];duration:number;mode:'original'|'external'|'mix'|'silent';videoVolume:number;musicVolume:number;externalUrls:string[];selection:{sourceInMs:number;sourceOutMs:number};secondary:{url:string;start:number;sourceStart:number;duration:number;volume:number;fadeIn:number;fadeOut:number}[];protectedRanges:{start:number;end:number;sourceAssetId?:string}[];extraFrameTimes:number[];sourceTime:(index:number,seconds:number)=>number;paint:(source:ExportDrawing|null,index:number,time:number)=>void;cancelled:()=>boolean;progress:(percent:number)=>void;audit?:(event:unknown)=>void};
const RATE=48000;
export async function renderTimelineExport(o:Options):Promise<Blob>{
 const m=await loadExportMedia(),original=(o.mode==='original'||o.mode==='mix')&&o.videoVolume>0,external=o.mode==='external'||o.mode==='mix';
 const media=new Map<string,ExportMedia>(),images=new Map<string,HTMLImageElement>(),spans=exportVisibleSpans(o.segments,o.duration);
 const abort=()=>{if(o.cancelled())throw new DOMException('已取消','AbortError');};
 let output:InstanceType<typeof m.Output>|undefined;
 try{
  let videoEncoderSupported=false;
  try{videoEncoderSupported=await m.canEncodeVideo('vp8',{width:o.canvas.width,height:o.canvas.height,bitrate:8_000_000});}catch{}
  if(!videoEncoderSupported)throw Error('当前浏览器不支持精确导出所需的 WebCodecs VP8 视频编码。请使用受支持的 Chrome 或 Edge；此次已安全拒绝，没有回退到实时录制。');
  for(const asset of o.assets.filter(a=>o.segments.some(s=>s.assetId===a.id))){
   abort();if(!asset.preview)throw Error('请重新关联素材：'+asset.name);
   if(asset.kind==='视频'){const resource=await openExportMedia(asset.preview,asset.name,true,original,o.cancelled);media.set(asset.id,resource);if(resource.audio)resource.audio=await pcmAtOutputRate(resource.audio);}
   else{const image=new Image();image.src=asset.preview;await image.decode();images.set(asset.id,image);}
  }

  for(const range of o.protectedRanges){
   if(range.start<0||range.end<=range.start||range.end>o.duration)throw Error("受保护讲话超出当前工程，未导出。");
   if(o.mode==='external'&&!range.sourceAssetId){if(range.end>(o.selection.sourceOutMs-o.selection.sourceInMs)/1000)throw Error('受保护旁白超出所选音频。');continue;}
   for(const span of spans.filter(s=>s.end>range.start&&s.start<range.end)){
    const segment=o.segments[span.index],pcm=segment&&media.get(segment.assetId)?.audio;
    if(!original||!pcm||(range.sourceAssetId&&segment.assetId!==range.sourceAssetId))throw Error('受保护讲话没有对应原声音轨。');
    const a=Math.round(o.sourceTime(span.index,Math.max(span.start,range.start))*RATE),b=Math.round(o.sourceTime(span.index,Math.min(span.end,range.end))*RATE);
    // Preserve genuine source-track lead-in/tail silence too; protection must not invent continuous speech.
    if(a<0||b<a)throw Error('受保护讲话的源时间映射无效，未导出。');
   }
  }
  const count=Math.round(o.duration*RATE);if(count*8>512*1024*1024)throw Error('工程超过本地精确导出的内存范围，请分段导出。');
  const planes=[new Float32Array(count),new Float32Array(count)];let includeAudio=false;
  function add(planesIn:Float32Array[],outStart:number,sourceStart:number,duration:number,volume:number,fadeIn=0,fadeOut=0){
   const a=Math.max(0,Math.round(outStart*RATE)),b=Math.min(count,Math.round((outStart+duration)*RATE)),offset=Math.round(sourceStart*RATE),base=Math.round(outStart*RATE);
   for(let n=a;n<b;n++){const i=offset+n-base;if(i<0||i>=planesIn[0].length)continue;let gain=volume;const elapsed=(n-base)/RATE;if(fadeIn>0)gain*=Math.min(1,elapsed/fadeIn);if(fadeOut>0)gain*=Math.min(1,(duration-elapsed)/fadeOut);for(let ch=0;ch<2;ch++)planes[ch][n]+=planesIn[Math.min(ch,planesIn.length-1)][i]*gain;}
  }
  if(original)for(const span of spans){abort();if(span.index<0)continue;const s=o.segments[span.index],pcm=media.get(s.assetId)?.audio;if(!pcm)continue;includeAudio=true;
    if(exportHasUnitSpeed(s)){add(pcm.planes,span.start,o.sourceTime(span.index,span.start),span.end-span.start,o.videoVolume);}
    else{
     const sourceStart=Math.round(o.sourceTime(span.index,span.start)*RATE),sourceEnd=Math.round(o.sourceTime(span.index,span.end)*RATE),length=sourceEnd-sourceStart;
     if(length<=0)throw Error('原声源范围无效，未生成静音替代。');
     const selected=pcm.planes.map(plane=>{const part=new Float32Array(length),a=Math.max(0,sourceStart),b=Math.min(plane.length,sourceEnd);if(b>a)part.set(plane.subarray(a,b),a-sourceStart);return part;});
     const frames=Math.round(span.end*RATE)-Math.round(span.start*RATE);
     const processed=await stretchExportPcm(selected,RATE,frames,t=>o.sourceTime(span.index,span.start+t)-sourceStart/RATE,o.cancelled);
     add(processed.planes,span.start,0,span.end-span.start,o.videoVolume);
     o.audit?.({type:'stretched-span',start:span.start,end:span.end,sourceStart,sourceEnd,outputSamples:frames,latency:processed.latency});
    }
   o.audit?.({type:'original-span',start:span.start,end:span.end,sourceStart:o.sourceTime(span.index,span.start),sourceIntervals:pcm.intervals,sampleRate:RATE});}
  async function decode(url:string){if(typeof OfflineAudioContext==='undefined')throw Error('当前浏览器缺少独立音频解码所需的 OfflineAudioContext；此次已安全拒绝，没有回退到实时录制。');const decoder=new OfflineAudioContext(2,1,RATE);abort();const response=await fetch(url);if(!response.ok)throw Error('无法读取独立或辅助音频。');const b=await decoder.decodeAudioData(await response.arrayBuffer());if(b.numberOfChannels>2)throw Error("精确导出尚未验证该多声道音频，未丢弃额外声道。");return{duration:b.duration,planes:Array.from({length:b.numberOfChannels},(_,ch)=>b.getChannelData(ch))};}
  if(external){let cursor=0;for(const url of o.externalUrls){const pcm=await decode(url),start=Math.max(cursor,o.selection.sourceInMs/1000),end=Math.min(cursor+pcm.duration,o.selection.sourceOutMs/1000);if(end>start){includeAudio=true;add(pcm.planes,start-o.selection.sourceInMs/1000,start-cursor,end-start,o.mode==='mix'?o.musicVolume:1);}cursor+=pcm.duration;}}
  if(o.mode!=='silent')for(const secondary of o.secondary){const pcm=await decode(secondary.url);includeAudio=true;add(pcm.planes,secondary.start,secondary.sourceStart,Math.min(secondary.duration,pcm.duration-secondary.sourceStart),secondary.volume,secondary.fadeIn,secondary.fadeOut);}
  if(o.mode==='external'&&!includeAudio)throw Error('所选独立音频没有可用样本。');
  if(includeAudio){let audioEncoderSupported=false;try{audioEncoderSupported=await m.canEncodeAudio('opus',{numberOfChannels:2,sampleRate:RATE,bitrate:192_000});}catch{}if(!audioEncoderSupported)throw Error('当前浏览器不支持精确导出所需的 WebCodecs Opus 音频编码。请使用受支持的 Chrome 或 Edge；此次已安全拒绝，没有回退到实时录制。');}
  const video=new m.CanvasSource(o.canvas,{codec:'vp8',bitrate:8_000_000}),audio=includeAudio?new m.AudioSampleSource({codec:'opus',bitrate:192_000}):null,target=new m.BufferTarget();
  output=new m.Output({format:new m.WebMOutputFormat(),target});output.addVideoTrack(video);if(audio)output.addAudioTrack(audio);await output.start();  const times=exportFrameTimes(o.duration,o.segments,o.extraFrameTimes);let iterator:AsyncGenerator<VideoSample|null,void,unknown>|undefined,previousIndex=-2;
  const writeVideo=async()=>{
   try{for(let i=0;i<times.length-1;i++){
    abort();const time=times[i]/1e6,index=exportSegmentIndexAt(o.segments,time);let sample:VideoSample|null=null,source:ExportDrawing|null=null;
    if(index!==previousIndex){await iterator?.return();iterator=undefined;const resource=index>=0?media.get(o.segments[index].assetId):undefined;if(resource?.video){const requests:number[]=[];for(let j=i;j<times.length-1&&exportSegmentIndexAt(o.segments,times[j]/1e6)===index;j++)requests.push(o.sourceTime(index,times[j]/1e6));iterator=new m.VideoSampleSink(resource.video).samplesAtTimestamps(requests);}previousIndex=index;}
    if(index>=0){const segment=o.segments[index],resource=media.get(segment.assetId),image=images.get(segment.assetId);
     if(resource?.video){const next=await iterator!.next();sample=next.value??null;const requested=o.sourceTime(index,time);if(!sample||sample.timestamp>requested+.000002||sample.timestamp+sample.duration<requested-.000002)throw Error('源视频在请求时间没有对应显示帧，未使用上一帧填补。');const frame=sample;source={width:frame.displayWidth,height:frame.displayHeight,draw:(ctx,x,y,w,h)=>frame.draw(ctx,x,y,w,h)};o.audit?.({type:'frame',outputPts:time,sourcePts:sample.timestamp,sourceDuration:sample.duration,segmentIndex:index});}
     else if(image)source={width:image.naturalWidth,height:image.naturalHeight,draw:(ctx,x,y,w,h)=>ctx.drawImage(image,x,y,w,h)};
     else throw Error('时间线素材未正确关联，未使用黑帧替代。');
    }
    try{o.paint(source,index,time);await video.add(time,(times[i+1]-times[i])/1e6);}finally{sample?.close();}
    if(i%8===0){o.progress(Math.min(99,Math.round(i/(times.length-1)*100)));await new Promise(resolve=>setTimeout(resolve,0));}
   }}finally{await iterator?.return();video.close();}
  };
  const writeAudio=async()=>{
   if(!audio)return;
   try{for(let from=0;from<count;from+=4096){abort();const n=Math.min(4096,count-from),data=new Float32Array(n*2);for(let ch=0;ch<2;ch++)data.set(planes[ch].subarray(from,from+n),ch*n);const sample=new m.AudioSample({data,format:'f32-planar',numberOfChannels:2,sampleRate:RATE,timestamp:from/RATE});try{await audio.add(sample);}finally{sample.close();}}}finally{audio.close();}
  };
  await Promise.all([writeVideo(),writeAudio()]);abort();await output.finalize();if(!target.buffer)throw Error('编码器未返回视频数据。');o.audit?.({type:'complete',videoFrames:times.length-1,audioSamples:includeAudio?count:0,duration:o.duration});return new Blob([target.buffer],{type:'video/webm'});
 }catch(e){try{await output?.cancel();}catch{}throw e;}finally{for(const resource of media.values())resource.input.dispose();}
}
