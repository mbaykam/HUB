import type {KnowledgeAsset,KnowledgeNote} from "../../knowledge-contract.ts";
/** Render only validated vault URLs or ordinary HTTP links; never vault HTML. */
export function createKnowledgeMedia(root:Document){
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const n=root.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const assetUrl=(path:string,download=false)=>`/api/hub/memory?view=asset&path=${encodeURIComponent(path)}${download?"&download=1":""}`;
  function target(value:string,notePath:string){
    let decoded:string;try{decoded=decodeURIComponent(value);}catch{return;}
    if(/^https?:\/\//i.test(decoded)){try{const url=new URL(decoded);return !url.username&&!url.password?{url:url.href,external:true}:undefined;}catch{return;}}
    if(/^[a-z]+:/i.test(decoded)||decoded.startsWith("//")||/[\\\u0000-\u001f]/.test(decoded))return;
    const base="https://vault.invalid/"+(notePath.includes("/")?notePath.slice(0,notePath.lastIndexOf("/")+1):"");
    const url=new URL(decoded,base);return {url:assetUrl(decodeURIComponent(url.pathname.slice(1))),path:decodeURIComponent(url.pathname.slice(1)),external:false};
  }
  function file(parent:HTMLElement,label:string,path:string,mediaType?:string){
    const card=el("figure");card.className="knowledge-media-card";const url=assetUrl(path);
    const image=mediaType?.startsWith("image/")||/\.(png|jpe?g|webp|gif)$/i.test(path);
    if(image){const img=el("img");img.src=url;img.alt=label;img.loading="lazy";card.append(img);}
    else if(mediaType?.startsWith("audio/")||/\.(mp3|wav)$/i.test(path)){const audio=el("audio");audio.controls=true;audio.preload="none";audio.src=url;card.append(audio);}
    else if(mediaType==="video/mp4"||/\.mp4$/i.test(path)){const video=el("video");video.controls=true;video.preload="metadata";video.setAttribute("playsinline","");video.src=url;card.append(video);}
    const caption=el("figcaption",label),open=el("a",image?"Open image":"Open file"),download=el("a","Download");open.href=url;open.target="_blank";open.rel="noopener noreferrer";download.href=assetUrl(path,true);download.download=label;card.append(caption,open,download);parent.append(card);
  }
  function renderBody(container:HTMLElement,note:KnowledgeNote,openNote:(id:string)=>void,nodes:{id:string;title:string;permalink:string}[]){
    container.replaceChildren();let code=false;
    for(const line of note.content.split("\n")){
      if(/^```/.test(line)){code=!code;continue;}if(!line.trim()){container.append(el("br"));continue;}
      const heading=line.match(/^(#{1,4})\s+(.+)$/);if(heading){container.append(el(("h"+Math.min(5,heading[1]!.length+1)) as "h2",heading[2]));continue;}
      const paragraph=el(code?"pre":"div");paragraph.className="knowledge-prose";if(code){paragraph.textContent=line;container.append(paragraph);continue;}
      let position=0;
      const pattern=/(!?)\[\[([^\]\n]+)\]\]|(!?)\[([^\]\n]+)\]\(([^\)\n]+)\)|(https?:\/\/[^\s<>"'\]\)]+)/g;
      for(const match of line.matchAll(pattern)){
        paragraph.append(root.createTextNode(line.slice(position,match.index)));
        if(match[2]){
          const [path,alias]=match[2].split("|");const label=alias||path!;const linked=nodes.find(n=>n.permalink===path||n.title===path||n.permalink.split("/").at(-1)===path);
          if(linked){const b=el("button",label);b.type="button";b.className="knowledge-inline-link";b.addEventListener("click",()=>openNote(linked.id));paragraph.append(b);}
          else {const resolved=target(path!,note.permalink);if(resolved?.path&&/\.[a-z0-9]{1,8}$/i.test(path!))file(paragraph,label,resolved.path);else paragraph.append(root.createTextNode(label));}
        }else{
          const label=match[4]??match[6]!,value=match[5]??match[6]!,resolved=target(value,note.permalink);
          if(resolved){if(!resolved.external&&resolved.path)file(paragraph,label,resolved.path);else{const a=el("a",label);a.href=resolved.url;a.target="_blank";a.rel="noopener noreferrer";paragraph.append(a);}}else paragraph.append(root.createTextNode(label));
        }
        position=match.index!+match[0].length;
      }
      paragraph.append(root.createTextNode(line.slice(position)));container.append(paragraph);
    }
  }
  return {file,renderBody,assetUrl,renderAssets(parent:HTMLElement,assets:KnowledgeAsset[]){parent.replaceChildren();for(const asset of assets)file(parent,asset.name,asset.path,asset.mediaType);if(!assets.length)parent.append(el("p","Your saved images and files will appear here."));}};
}
