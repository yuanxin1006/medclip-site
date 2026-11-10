import type * as Media from './vendor/mediabunny';
export type Bunny = typeof Media;
let library:Promise<Bunny>|undefined;
export function loadExportMedia(){
 const local='/medclip-export/mediabunny-1.65.2.mjs';
 return library??=import(/* webpackIgnore: true */ local) as Promise<Bunny>;
}
export type ExportPcm={rate:number;planes:Float32Array[];first:number;end:number;intervals:{start:number;end:number}[]};
export type ExportMedia={input:Media.Input;video:Media.InputVideoTrack|null;audio:ExportPcm|null;image?:HTMLImageElement;name:string};
export async function decodeExportPcm(m:Bunny,track:Media.InputAudioTrack,signal:()=>boolean):Promise<ExportPcm>{
 const parts:{at:number;data:Float32Array[]}[]=[];let rate=0,channels=0,end=0,first=Infinity;
 for await(const sample of new m.AudioSampleSink(track).samples()){
  try{
   if(signal())throw new DOMException('已取消','AbortError');
   rate||=sample.sampleRate;channels||=sample.numberOfChannels;
   if(channels>2||rate!==sample.sampleRate||channels!==sample.numberOfChannels)throw Error('该音轨声道或采样率变化，尚不支持精确导出。');
   const at=Math.round(sample.timestamp*rate);
   const data=Array.from({length:channels},(_,planeIndex)=>{const p=new Float32Array(sample.numberOfFrames);sample.copyTo(p,{planeIndex,format:'f32-planar'});return p;});
   parts.push({at,data});first=Math.min(first,sample.timestamp);end=Math.max(end,sample.timestamp+sample.duration);
   if(end*rate*channels*4>512*1024*1024)throw Error('源音轨超过本地精确导出的内存范围，请先缩短素材。');
  }finally{sample.close();}
 }
 if(!rate)throw Error('音轨存在但没有解码出PCM，未生成静音替代。');
 const length=Math.max(1,Math.round(end*rate)),planes=Array.from({length:channels},()=>new Float32Array(length));
 const intervals:{start:number;end:number}[]=[];let previousEnd=-Infinity;
 for(const part of parts){
  const from=Math.max(0,part.at),to=Math.min(length,part.at+part.data[0].length);if(to<=from)continue;
  // Duplicate decoded samples must not be mixed twice. Container gaps remain explicit source intervals.
  const start=Math.max(from,previousEnd);if(to<=start)continue;
  for(let ch=0;ch<channels;ch++)planes[ch].set(part.data[ch].subarray(start-part.at,to-part.at),start);
  if(intervals.length&&start<=intervals.at(-1)!.end+1)intervals.at(-1)!.end=to;else intervals.push({start,end:to});
  previousEnd=to;
 }
 return{rate,planes,first:Math.max(0,first),end,intervals};
}
export async function openExportMedia(url:string,name:string,isVideo:boolean,original:boolean,signal:()=>boolean):Promise<ExportMedia>{
 const m=await loadExportMedia(),response=await fetch(url);if(!response.ok)throw Error('无法读取素材：'+name);
 let input:Media.Input;
 try{input=new m.Input({source:new m.BlobSource(await response.blob()),formats:[m.MP4]});}
 catch{throw Error('精确导出当前只接受可解析的 MP4 容器；该素材已安全拒绝，没有回退到实时录制。');}
 try{
  const video=await input.getPrimaryVideoTrack();if(isVideo&&!video)throw Error('素材没有视频轨：'+name);
  if(video&&(!await video.canDecode()))throw Error('当前浏览器不能按帧解码：'+name);
  const audioTrack=original?await input.getPrimaryAudioTrack():null;
  if(audioTrack&&await audioTrack.getCodec()!=='aac')throw Error('精确导出当前仅验收MP4/AAC原声；未静默换用其他音轨。');
  if(audioTrack&&!await audioTrack.canDecode())throw Error('当前浏览器不能按帧解码 MP4/AAC 原声音轨；此次已安全拒绝，没有回退到实时录制。');
  const audio=audioTrack?await decodeExportPcm(m,audioTrack,signal):null;
  return{input,video,audio,name};
 }catch(e){input.dispose();throw e;}
}
export async function pcmAtOutputRate(pcm:ExportPcm,rate=48000):Promise<ExportPcm>{
 if(pcm.rate===rate)return pcm;
 if(typeof OfflineAudioContext==='undefined')throw Error('当前浏览器缺少原声重采样所需的 OfflineAudioContext；此次已安全拒绝，没有回退到实时录制。');
 const offline=new OfflineAudioContext(pcm.planes.length,Math.ceil(pcm.end*rate),rate),buffer=offline.createBuffer(pcm.planes.length,pcm.planes[0].length,pcm.rate);
 pcm.planes.forEach((p,ch)=>buffer.copyToChannel(new Float32Array(p),ch));const src=offline.createBufferSource();src.buffer=buffer;src.connect(offline.destination);src.start(0);
 const output=await offline.startRendering();return{...pcm,rate,planes:Array.from({length:output.numberOfChannels},(_,ch)=>output.getChannelData(ch).slice()),intervals:pcm.intervals.map(x=>({start:Math.round(x.start/pcm.rate*rate),end:Math.round(x.end/pcm.rate*rate)}))};
}
