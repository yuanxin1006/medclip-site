import type {EditorProject} from './editor-core.ts';
export function validateOutputDimensions(width:number,height:number){if(![width,height].every(n=>Number.isSafeInteger(n)&&n>=128&&n<=3840&&n%2===0)||width*height>8294400)throw Error('输出宽高须为 128–3840 的偶数整数，总像素不超过 8294400；实际编码能力还取决于浏览器。');return {width,height};}
export function outputCanvasSize(ratio:string){
 const preset:Record<string,{width:number;height:number}>={'9:16':{width:1080,height:1920},'16:9':{width:1920,height:1080},'1:1':{width:1080,height:1080}};
 const match=/^(\d+):(\d+)$/.exec(ratio),size=preset[ratio]??(match?{width:Number(match[1]),height:Number(match[2])}:null);
 if(!size||![size.width,size.height].every(n=>Number.isSafeInteger(n)&&n>=128&&n<=3840&&n%2===0)||size.width*size.height>8294400)throw Error('输出宽高须为 128–3840 的偶数整数，总像素不超过 8294400；实际编码能力还取决于浏览器。');
 return validateOutputDimensions(size.width,size.height);
}
export function changeOutputCanvas(project:EditorProject,ratio:string,fit:'contain'|'cover'|undefined,protectedContent=false){
 outputCanvasSize(ratio);
 const clips=project.tracks.flatMap(t=>t.clips);
 if(protectedContent&&ratio!==project.ratio&&clips.some(c=>c.transform.scale>1||c.transform.crop>0||c.transform.x!==0||c.transform.y!==0))throw Error('受保护画面已有位置、缩放或裁剪，无法确认更换画布后边缘安全。请先核对保护画面。');
 if(protectedContent&&(fit==='cover'||(ratio!==project.ratio&&clips.some(c=>(fit??c.transform.fit)==='cover'))))throw Error('当前工程有保护约束，不能确认填满后的边缘裁切安全。请选择完整显示并核对保护范围。');
 return {...project,ratio,tracks:project.tracks.map(t=>({...t,clips:t.clips.map(c=>fit?{...c,transform:{...c.transform,fit}}:c)}))};
}

export function isCanvasOnlyChange(a:EditorProject,b:EditorProject){const strip=(p:EditorProject)=>({...p,ratio:'',updatedAt:'',tracks:p.tracks.map(t=>({...t,clips:t.clips.map(c=>({...c,transform:{...c.transform,fit:'cover'}}))}))});return JSON.stringify(strip(a))===JSON.stringify(strip(b));}
