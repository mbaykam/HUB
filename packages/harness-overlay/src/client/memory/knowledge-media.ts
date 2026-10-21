import type {KnowledgeAsset,KnowledgeNote} from "../../knowledge-contract.ts";
/** Render only validated vault URLs or ordinary HTTP links; never vault HTML. */
export function createKnowledgeMedia(root:Document){
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const n=root.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const assetUrl=(path:string,download=false)=>`/api/hub/memory?view=asset&path=${encodeURIComponent(path)}${download?"&download=1":""}`;
  function target(value:string,notePath:string,assets:KnowledgeAsset[]=[]){
    let decoded:string;try{decoded=decodeURIComponent(value);}catch{decoded=value;}
    if(/^https?:\/\//i.test(decoded)){try{const url=new URL(decoded);return !url.username&&!url.password?{url:url.href,external:true}:undefined;}catch{return;}}
    if(/^[a-z]+:/i.test(decoded)||decoded.startsWith("//")||/[\\\u0000-\u001f]/.test(decoded))return;
    const folder=notePath.split("/").slice(0,-1).map(encodeURIComponent).join("/"),base="https://vault.invalid/"+(folder?folder+"/":"");
    try{
      // Older original transcripts contain literal file paths. Match their
      // retained asset before decoding, so a real percent sign stays a percent.
      const literal=decodeURIComponent(new URL(value.split("/").map(encodeURIComponent).join("/"),base).pathname.slice(1));
      const original=assets.find(a=>a.path===literal),url=new URL(value,base);
      const path=original?.path??decodeURIComponent(url.pathname.slice(1));
      return {url:assetUrl(path),path,external:false};
    }catch{return;}
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
      const pattern=/(!?)\[\[([^\]\n]+)\]\]|(!?)\[([^\]\n]+)\]\(|(https?:\/\/[^\s<>"'\]\)]+)/g;
      let match:RegExpExecArray|null;
      while((match=pattern.exec(line))){
        let end=pattern.lastIndex,destination:string|undefined;
        if(match[4]){
          const start=end;let depth=1;
          while(end<line.length&&depth){const char=line[end++];if(char==="\\"&&/[()\\]/.test(line[end]??"")){end++;continue;}if(char==="(")depth++;else if(char===")")depth--;}
          if(depth)break;destination=line.slice(start,end-1).replace(/\\([()\\])/g,"$1");pattern.lastIndex=end;
        }
        paragraph.append(root.createTextNode(line.slice(position,match.index)));
        if(match[2]){
          const [path,alias]=match[2].split("|");const label=alias||path!;const linked=nodes.find(n=>n.permalink===path||n.title===path||n.permalink.split("/").at(-1)===path);
          if(linked){const b=el("button",label);b.type="button";b.className="knowledge-inline-link";b.addEventListener("click",()=>openNote(linked.id));paragraph.append(b);}
          else {const resolved=target(path!,note.permalink,note.assets);if(resolved?.path&&/\.[a-z0-9]{1,8}$/i.test(path!))file(paragraph,label,resolved.path);else paragraph.append(root.createTextNode(label));}
        }else{
          const label=match[4]??match[5]!,value=destination??match[5]!,resolved=target(value,note.permalink,note.assets);
          if(resolved){if(!resolved.external&&resolved.path)file(paragraph,label,resolved.path);else{const a=el("a",label);a.href=resolved.url;a.target="_blank";a.rel="noopener noreferrer";paragraph.append(a);}}else paragraph.append(root.createTextNode(label));
        }
        position=end;
      }
      paragraph.append(root.createTextNode(line.slice(position)));container.append(paragraph);
    }
  }
  return {file,renderBody,assetUrl,renderAssets(parent:HTMLElement,assets:KnowledgeAsset[]){parent.replaceChildren();for(const asset of assets)file(parent,asset.name,asset.path,asset.mediaType);if(!assets.length)parent.append(el("p","Your saved images and files will appear here."));}};
}
