"use client";
import {useEffect,useState,type HTMLAttributes} from "react";
import type {TimelineCaption} from "./editor-core";
import {captionPresentation,captionCanvasSize,captionTextLayout,captionOutlineColor,captionSafeAnchor} from "./editor-captions";
type Props=Omit<HTMLAttributes<HTMLDivElement>,"children"> & {caption?:TimelineCaption|null;ratio:string;presentation?:ReturnType<typeof captionPresentation>|null};
export function EditorCaptionView({caption,ratio,presentation,style:extra,...props}:Props){
 const style=presentation??captionPresentation(caption??{id:"",text:"",startMs:0,endMs:0}),size=captionCanvasSize(ratio);
 const [lines,setLines]=useState([caption?.text??""]);
 const [blockWidth,setBlockWidth]=useState(0);
 const fontPx=Math.max(12,Math.round(style.fontSize*size.height/1080));
 useEffect(()=>{let alive=true;const update=()=>{const ctx=document.createElement("canvas").getContext("2d");if(!ctx)return;ctx.font="700 "+fontPx+"px Microsoft YaHei, sans-serif";const next=captionTextLayout(caption?.text??"",t=>ctx.measureText(t).width,size.width*.84);if(alive){setLines(next);setBlockWidth(Math.max(...next.map(line=>ctx.measureText(line).width),0));}};update();void document.fonts.ready.then(update);return()=>{alive=false;};},[caption?.text,fontPx,size.width]);
 const outline=captionOutlineColor(style.color),stroke=Math.max(2,Math.round(size.width/420));
 let anchor={x:style.x*size.width,y:style.y*size.height};try{anchor=captionSafeAnchor(style,size.width,size.height,blockWidth,lines.length*fontPx*1.4);}catch{}
 if(!caption)return null;
 return <div {...props} data-caption-id={caption.id} data-caption-source="project" style={{
  color:style.color,fontSize:(fontPx/size.width*100)+"cqi",fontWeight:700,lineHeight:1.4,
  left:(anchor.x/size.width*100)+"%",top:(anchor.y/size.height*100)+"%",bottom:"auto",opacity:style.opacity,
  textAlign:style.alignment,transform:"translate("+(style.alignment==="left"?"0":style.alignment==="right"?"-100":"-50")+"%, -50%)",
  maxWidth:"84%",width:"max-content",padding:0,background:"transparent",whiteSpace:"pre",textShadow:"none",
  WebkitTextStroke:(stroke/size.width*100)+"cqi "+outline,paintOrder:"stroke fill",...extra
 }}>{lines.map((line,index)=><span key={index} data-caption-line style={{display:"block",whiteSpace:"pre"}}>{line||"\u00a0"}</span>)}</div>;
}
