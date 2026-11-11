/** Keep the real editor, attachment state and send/stop handlers in their seats. */
export function compactComposer(card:HTMLElement){
  const more=card.querySelector<HTMLElement>('[aria-label="More actions"]');
  if(!more)return;
  card.setAttribute('data-hub-compact-composer','');
  more.setAttribute('data-hub-composer-menu','');
  const tools=more.parentElement?.parentElement,row=tools?.parentElement;
  tools?.setAttribute('data-hub-composer-tools','');
  row?.setAttribute('data-hub-composer-row','');
  const trailing=row?.lastElementChild;
  trailing?.setAttribute('data-hub-composer-trailing','');
  const buttons=trailing?.querySelectorAll('button');
  buttons?.[buttons.length-1]?.setAttribute('data-hub-composer-send','');
  const placeholder=card.querySelector<HTMLElement>('[data-composer-placeholder]');
  if(placeholder&&/^(Ask anything|Message or run a task)/i.test(placeholder.textContent??''))placeholder.textContent='Chat…';
  const input=card.querySelector<HTMLElement>('[contenteditable]');
  if(input&&/^(Ask anything|Message or run a task)/i.test(input.getAttribute('aria-label')??''))input.setAttribute('aria-label','Chat');
}
