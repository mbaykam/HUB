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
  if(placeholder&&/^(Ask anything|Message or run a task)/i.test(placeholder.textContent??''))placeholder.textContent='Chat…';
  const input=card.querySelector<HTMLElement>('[contenteditable]');
  if(input&&/^(Ask anything|Message or run a task)/i.test(input.getAttribute('aria-label')??''))input.setAttribute('aria-label','Chat');
}
