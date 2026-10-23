import {useEffect,useRef} from "react";
import type {HarnessClientContext} from "../core/context.ts";
import {createCharacterPicker} from "./character-picker.ts";
export function installComposerCharacterPicker(ctx:HarnessClientContext,root:Document=document){
  function Control({sessionId}:{sessionId:string}){const anchor=useRef<HTMLSpanElement>(null);useEffect(()=>{const picker=createCharacterPicker(root,()=>sessionId);anchor.current?.append(picker.button);return()=>picker.dispose();},[sessionId]);return <span ref={anchor}/>;}
  return ctx.slots.register({name:"conversation.input.left",id:"hub-character-picker",order:-90},Control);
}
