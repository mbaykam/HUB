import {anchoredPopover} from "./character-picker.ts";

/** Keep the same three-control layout while the real workspace picker owns input.
 * This recovery menu never enables the session's locked message controls. */
export function createWorkspaceComposerMenu(root:Document){
  const button=root.createElement("button");button.type="button";button.textContent="+";
  button.className="hub-composer-button";button.setAttribute("aria-label","More actions");
  button.setAttribute("data-hub-workspace-menu","");button.setAttribute("aria-expanded","false");
  let card:HTMLElement|undefined,popup:ReturnType<typeof anchoredPopover>|undefined;
  const close=()=>{const current=popup;popup=undefined;if(current?.panel.isConnected)current.close();};
  button.addEventListener("click",event=>{
    event.stopPropagation();
    if(popup?.panel.isConnected){close();return;}
    popup=anchoredPopover(root,button,"More actions");
    const choose=root.createElement("button");choose.type="button";choose.textContent="Choose workspace…";
    choose.onclick=()=>{close();card?.querySelector<HTMLElement>('[contenteditable][aria-haspopup="menu"]')?.click();};
    popup.panel.append(choose);popup.place();choose.focus();
  });
  return {update(next:HTMLElement|undefined){
    const picker=next?.querySelector('[contenteditable][aria-haspopup="menu"]');
    const liveMenu=next?.querySelector('[aria-label="More actions"]:not([data-hub-workspace-menu])');
    const row=next?.lastElementChild,tools=row?.firstElementChild;
    if(!picker||liveMenu||!tools||tools===row?.lastElementChild){close();if(button.isConnected)button.remove();card=undefined;return;}
    card=next;if(button.parentElement!==tools)tools.append(button);
  },dispose(){close();button.remove();card=undefined;}};
}

/** Keep the voice owner outside React's native card while sharing its geometry. */
export function seatComposerVoice(hub:HTMLElement,stack:HTMLElement,card:HTMLElement|undefined,idle:boolean){
  if(hub.parentElement!==stack)stack.prepend(hub);
  if(idle&&card){
    const outer=stack.getBoundingClientRect(),inner=card.getBoundingClientRect();
    const primary=card.querySelector<HTMLElement>('[data-hub-composer-send]')?.getBoundingClientRect();
    hub.style.right=`${primary?outer.right-primary.left+8:outer.right-inner.right+60}px`;
    hub.style.bottom=`${primary?outer.bottom-primary.bottom:outer.bottom-inner.bottom+9}px`;
  }else{hub.style.removeProperty("right");hub.style.removeProperty("bottom");}
}
const stopFocusCards=new WeakSet<HTMLElement>();
function preventStopEditorFocus(card:HTMLElement){
  if(stopFocusCards.has(card))return;
  stopFocusCards.add(card);
  card.addEventListener("mousedown",event=>{
    if(!card.ownerDocument.documentElement.hasAttribute("data-minke-mobile-web"))return;
    const button=(event.target as Element).closest?.('button');
    if(!button||!card.contains(button))return;
    const stop=button.hasAttribute('data-hub-composer-stop')||
      (button.hasAttribute('data-hub-composer-send')&&button.querySelector('svg rect')!==null);
    if(!stop)return;
    // Upstream keepFocus deliberately focuses the editor on mousedown. A Stop
    // tap must keep the keyboard closed; its original click handler still owns
    // cancellation, including keyboard/assistive activation.
    event.preventDefault();event.stopPropagation();
  },true);
}

/** Keep the real editor, attachment state and send/stop handlers in their seats. */
export function compactComposer(card:HTMLElement){
  const more=card.querySelector<HTMLElement>('[aria-label="More actions"]');
  if(!more)return;
  // Slot outlets add display:contents wrappers. Find the toolbar by its
  // relationship to the card, never by counting parents of a slot control.
  let row:HTMLElement|null=more;
  while(row&&row.parentElement!==card)row=row.parentElement;
  if(!row||row===card)return;
  let tools:HTMLElement|null=more;
  while(tools&&tools.parentElement!==row)tools=tools.parentElement;
  const trailing=row.lastElementChild;
  if(!tools||!trailing||trailing===tools)return;
  const buttons=trailing.querySelectorAll('button');
  const send=buttons[buttons.length-1];
  if(!send)return;
  // Reconciliation also repairs markers installed by an older overlay.
  for(const node of card.querySelectorAll('[data-hub-composer-row],[data-hub-composer-tools],[data-hub-composer-trailing],[data-hub-composer-send]')){
    for(const name of ['row','tools','trailing','send'])node.removeAttribute(`data-hub-composer-${name}`);
  }
  card.setAttribute('data-hub-compact-composer','');
  preventStopEditorFocus(card);
  more.setAttribute('data-hub-composer-menu','');
  tools.setAttribute('data-hub-composer-tools','');
  row.setAttribute('data-hub-composer-row','');
  trailing.setAttribute('data-hub-composer-trailing','');
  send.setAttribute('data-hub-composer-send','');
  for(const node of card.querySelectorAll('[data-hub-composer-stop]'))node.removeAttribute('data-hub-composer-stop');
  const independentStop=Array.from(trailing.children).find(node=>node!==send&&node.tagName==='BUTTON'&&node.className===send.className);
  independentStop?.setAttribute('data-hub-composer-stop','');
  card.toggleAttribute('data-hub-composer-independent-stop',!!independentStop);
  const placeholder=card.querySelector<HTMLElement>('[data-composer-placeholder]');
  if(placeholder&&placeholder.textContent!=='Chat…'&&(/^(Ask anything|Message or run a task)/i.test(placeholder.textContent??'')||more.hasAttribute('data-hub-workspace-menu')))placeholder.textContent='Chat…';
  const input=card.querySelector<HTMLElement>('[contenteditable]');
  if(input&&/^(Ask anything|Message or run a task)/i.test(input.getAttribute('aria-label')??''))input.setAttribute('aria-label','Chat');
}
