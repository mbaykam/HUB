/** Ephemeral view of official voice events; native history remains the only
 * durable transcript. Render text, never model-supplied HTML. */
export function createMobileLiveTranscript(root: Document) {
  const panel = root.createElement("section"); panel.setAttribute("data-hub-live-transcript", "");
  panel.setAttribute("aria-label", "Live transcript");
  const heading = root.createElement("div"); heading.setAttribute("data-transcript-heading", "");
  const title = root.createElement("span"); title.textContent = "Live transcript";
  const latest = root.createElement("button"); latest.type = "button"; latest.textContent = "Latest ↓"; latest.hidden = true;
  heading.append(title, latest);
  const list = root.createElement("div"); list.setAttribute("data-transcript-lines", "");
  list.setAttribute("role", "log"); list.setAttribute("aria-label", "Voice conversation");
  list.setAttribute("aria-live", "off"); list.tabIndex = 0;
  const empty = root.createElement("p"); empty.setAttribute("data-transcript-empty", "");
  empty.textContent = "Your words and Conversation’s replies will appear here.";
  const announcement = root.createElement("span"); announcement.setAttribute("data-transcript-announcement", "");
  announcement.setAttribute("role", "status"); announcement.setAttribute("aria-live", "polite");
  panel.append(heading, list, empty, announcement);
  type Line = { role: "user" | "assistant"; text: string; final: boolean; node: HTMLElement; body: HTMLElement };
  const lines: Line[] = [];
  let follow = true, scrollFrame: number | undefined, disposed = false, assistantName = "Conversation";
  const view = root.defaultView;
  function scrollToLatest() {
    if (!view || scrollFrame !== undefined) return;
    scrollFrame = view.requestAnimationFrame(() => { scrollFrame = undefined; if (follow) list.scrollTop = list.scrollHeight; });
  }
  function onScroll() { follow = list.scrollHeight - list.clientHeight - list.scrollTop < 36; latest.hidden = follow; }
  list.addEventListener("scroll", onScroll, { passive: true });
  latest.addEventListener("click", () => { follow = true; latest.hidden = true; scrollToLatest(); });
  function reset() { lines.length = 0; panel.removeAttribute("data-has-transcript"); list.replaceChildren(); empty.hidden = false; announcement.textContent = ""; follow = true; latest.hidden = true; }
  const api = {
    panel,
    reset,
    setAssistant(name: string) {
      assistantName = name.trim() || "Conversation";
      for (const line of lines) if (line.role === "assistant") line.node.querySelector("strong")!.textContent = assistantName;
      empty.textContent = `Your words and ${assistantName}’s replies will appear here.`;
    },
    update(role: "user" | "assistant", text: string, final: boolean) {
      if (disposed || !text.trim()) return;
      panel.setAttribute("data-has-transcript", "");
      const previous = lines.at(-1);
      // Human partials replace their draft. Spoken assistant chunks accumulate
      // in one reply until another speaker starts, including punctuation chunks.
      let line = previous?.role === role && (role === "assistant" || !previous.final) ? previous : undefined;
      if (!line) {
        const node = root.createElement("div"); node.setAttribute("data-transcript-speaker", role);
        const label = root.createElement("strong"); label.textContent = role === "user" ? "You" : assistantName;
        const body = root.createElement("p"); node.append(label, body); list.append(node);
        line = { role, text: "", final: false, node, body }; lines.push(line);
      }
      if (role === "assistant" && line.text) {
        const gap = /\s$/.test(line.text) || /^\s|^[,.;:!?…\)\]}]/.test(text) ? "" : " ";
        line.text = (line.text + gap + text).slice(-12_000);
      } else line.text = text.slice(0, 12_000);
      line.final = final;
      line.body.textContent = line.text;
      line.node.toggleAttribute("data-interim", !final);
      empty.hidden = true;
      while (lines.length > 60 || (lines.length > 1 && lines.reduce((sum, item) => sum + item.text.length, 0) > 32_000)) lines.shift()!.node.remove();
      if (final) announcement.textContent = `${role === "user" ? "You" : assistantName}: ${text}`;
      if (follow) scrollToLatest(); else latest.hidden = false;
    },
    dispose() { disposed = true; if (scrollFrame !== undefined) view?.cancelAnimationFrame(scrollFrame); list.removeEventListener("scroll", onScroll); reset(); panel.remove(); },
  };
  return { ...api, snapshot(items: { role: "user" | "assistant"; text: string; final: boolean }[]) {
    const following = follow, position = list.scrollTop; reset(); follow = following;
    for (const item of items) api.update(item.role, item.text, item.final);
    if (!following) { list.scrollTop = position; latest.hidden = false; }
  } };
}
