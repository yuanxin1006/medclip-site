type StretchWasm={HEAP8:Int8Array;_presetDefault:(channels:number,rate:number)=>void;_reset:()=>void;_inputLatency:()=>number;_outputLatency:()=>number;_setBuffers:(channels:number,length:number)=>number;_seek:(length:number,rate:number)=>void;_process:(input:number,output:number)=>void;_setTransposeSemitones:(semitones:number,tonality:number)=>void;_setFormantSemitones:(semitones:number,compensate:boolean)=>void;_setFormantBase:(value:number)=>void};
type StretchLibrary={createStretchWasm:()=>Promise<StretchWasm>};
let factory:Promise<StretchLibrary>|undefined;
export async function stretchExportPcm(input:Float32Array[],sampleRate:number,outputFrames:number,sourceTime:(time:number)=>number,cancelled:()=>boolean){
 const url='/medclip-export/signalsmith-1.3.2-offline.mjs';
 factory??=import(/* webpackIgnore: true */url) as Promise<StretchLibrary>;
 const library=await factory!;
 const duration=outputFrames/sampleRate,step=1/sampleRate;
 const derivative=(t:number)=>(sourceTime(Math.min(duration,t+step))-sourceTime(Math.max(0,t-step)))/(Math.min(duration,t+step)-Math.max(0,t-step));
 const startRate=derivative(0),endRate=derivative(duration);
 for(let t=0;t<=duration;t+=.01){const rate=derivative(t);if(!Number.isFinite(rate)||rate<.5-.001||rate>4.001)throw Error('精确变速原声当前仅验证0.5至4倍，未改变工程速度；更慢速度需另行验证。');}
 const module=await library.createStretchWasm(),channels=input.length;
 module._presetDefault(channels,sampleRate);module._reset();module._setTransposeSemitones(0,8000/sampleRate);module._setFormantSemitones(0,false);module._setFormantBase(0);
 const inputLatency=module._inputLatency(),outputLatency=module._outputLatency(),length=inputLatency+outputLatency,ptr=module._setBuffers(channels,length);
 const output=Array.from({length:channels},()=>new Float32Array(outputFrames));
 const map=(t:number)=>t<0?sourceTime(0)+t*startRate:t>duration?sourceTime(duration)+(t-duration)*endRate:sourceTime(t);
 let previousEnd:number|undefined;
 // Prepare the synthesis history at negative project times; emit only requested samples.
 const warmup=Math.ceil(outputLatency/128)*128;
 for(let from=-warmup;from<outputFrames;from+=128){
  if(cancelled())throw new DOMException('已取消','AbortError');
  const n=Math.min(128,outputFrames-from),t=from/sampleRate+outputLatency/sampleRate,end=Math.round((map(t)+inputLatency/sampleRate)*sampleRate),start=previousEnd===undefined?end-length:previousEnd,consumed=end-start;
  if(consumed<0||consumed>length)throw Error('原声音频源时间映射不连续，未生成替代静音。');
  for(let ch=0;ch<channels;ch++){const buffer=new Float32Array(module.HEAP8.buffer,ptr+length*4*ch,length);buffer.fill(0);const a=Math.max(0,start),b=Math.min(input[ch].length,end);if(b>a)buffer.set(input[ch].subarray(a,b),a-start);}
  if(previousEnd===undefined){module._seek(length,t>=duration?endRate:derivative(t));module._process(0,128);}else module._process(consumed,128);
  previousEnd=end;
  if(from>=0)for(let ch=0;ch<channels;ch++)output[ch].set(new Float32Array(module.HEAP8.buffer,ptr+length*4*(channels+ch),n),from);
  if(from%(128*64)===0)await new Promise(resolve=>setTimeout(resolve,0));
 }
 return{planes:output,latency:{inputSamples:inputLatency,outputSamples:outputLatency},sourceStart:sourceTime(0),sourceEnd:sourceTime(duration)};
}