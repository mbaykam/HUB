/** Research claims are paragraphs, not arbitrary HTML documents. Render their
 * inline links/emphasis as DOM nodes; never interpret page/model text as HTML. */
export function researchParagraph(root:Document,text:string){
  const p=root.createElement("p"),pattern=/\[([^\]\n]{1,400})\]\((https?:\/\/[^\s<>]{1,3000}?)\)|\*\*([^*\n]{1,3000})\*\*|`([^`\n]{1,3000})`|\*([^*\n]{1,3000})\*/g;
  let start=0;
  for(const m of text.matchAll(pattern)){
    p.append(root.createTextNode(text.slice(start,m.index)));
    if(m[1]&&m[2]){let url:URL|undefined;try{const parsed=new URL(m[2]);if(["http:","https:"].includes(parsed.protocol)&&!parsed.username&&!parsed.password)url=parsed;}catch{}
      if(url){const a=root.createElement("a");a.textContent=m[1];a.href=url.href;a.target="_blank";a.rel="noopener noreferrer";p.append(a);}else p.append(root.createTextNode(m[0]));
    }else{const node=root.createElement(m[3]?"strong":m[4]?"code":"em");node.textContent=m[3]??m[4]??m[5]??"";p.append(node);}
    start=m.index+m[0].length;
  }
  p.append(root.createTextNode(text.slice(start)));return p;
}
