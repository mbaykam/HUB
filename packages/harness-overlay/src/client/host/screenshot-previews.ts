interface Screenshot {id: string; name: string; turn: number}
interface Preview {item: Screenshot; figure: HTMLElement; controller?: AbortController; url?: string}

/** Mount saved results beside their native turn, including after history replay. */
export function createScreenshotPreviews(root: Document, load: (id: string, signal: AbortSignal) => Promise<Blob>) {
  const view = root.defaultView!;
  let items: Screenshot[] = [];
  const previews = new Map<string, Preview>();
  const visible = typeof view.IntersectionObserver === "function" ? new view.IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      visible?.unobserve(entry.target);
      const preview = previews.get((entry.target as HTMLElement).dataset.hubScreenshot ?? "");
      if (preview) void open(preview);
    }
  }) : undefined;

  function remove(preview: Preview) {
    visible?.unobserve(preview.figure);
    preview.controller?.abort();
    if (preview.url) view.URL.revokeObjectURL(preview.url);
    preview.figure.remove();
  }

  async function open(preview: Preview) {
    if (preview.controller || preview.url || !preview.figure.isConnected) return;
    const controller = new AbortController();
    preview.controller = controller;
    const status = preview.figure.querySelector("[role=status]")!;
    status.textContent = "Loading screenshot…";
    try {
      const blob = await load(preview.item.id, controller.signal);
      if (controller.signal.aborted) return;
      if (!/^image\/(png|jpeg|webp)$/u.test(blob.type) || !blob.size || blob.size > 8 * 1024 * 1024) throw new Error("Invalid screenshot");
      preview.url = view.URL.createObjectURL(blob);
      const image = root.createElement("img");
      image.alt = preview.item.name;
      image.src = preview.url;
      image.decoding = "async";
      image.addEventListener("error", () => {
        image.remove();
        if (preview.url) view.URL.revokeObjectURL(preview.url);
        preview.url = undefined;
        retry(status, preview);
      }, {once: true});
      status.replaceChildren();
      preview.figure.prepend(image);
    } catch {
      if (!controller.signal.aborted) retry(status, preview);
    } finally { preview.controller = undefined; }
  }

  function retry(status: Element, preview: Preview) {
    const button = root.createElement("button");
    button.type = "button";
    button.textContent = "Retry screenshot";
    button.onclick = () => void open(preview);
    status.replaceChildren(button);
  }

  function place() {
    const expected = new Set(items.map(item => item.id));
    for (const [id, preview] of previews) {
      if (expected.has(id) && preview.figure.isConnected) continue;
      remove(preview);
      previews.delete(id);
    }
    if (!items.length) return;
    const anchors = new Map<number, HTMLElement>();
    for (const node of root.querySelectorAll<HTMLElement>('[data-slot="conversation.view"] [data-chat-turn][data-chat-flow-kind]:not([hidden]):not([data-turn-process-hidden])')) {
      const turn = Number(node.dataset.chatTurn);
      const current = anchors.get(turn);
      if (!current || current.dataset.chatFlowKind !== "assistant" || node.dataset.chatFlowKind === "assistant") anchors.set(turn, node);
    }
    for (const item of items) {
      const anchor = anchors.get(item.turn);
      const existing = previews.get(item.id);
      if (!anchor || existing?.figure.parentElement === anchor) continue;
      if (existing) {
        anchor.append(existing.figure);
        continue;
      }
      const figure = root.createElement("figure");
      const caption = root.createElement("figcaption");
      const status = root.createElement("div");
      figure.dataset.hubScreenshot = item.id;
      caption.textContent = item.name;
      status.setAttribute("role", "status");
      figure.append(caption, status);
      const preview = {item, figure};
      previews.set(item.id, preview);
      anchor.append(figure);
      if (visible) visible.observe(figure);
      else void open(preview);
    }
  }

  return {
    update(value: unknown) {
      items = Array.isArray(value) ? value.filter((item): item is Screenshot =>
        !!item && typeof item.id === "string" && /^[a-f0-9]{64}$/u.test(item.id) &&
        typeof item.name === "string" && item.name.length <= 255 && Number.isSafeInteger(item.turn)) : [];
      place();
    },
    place,
    dispose() {
      visible?.disconnect();
      for (const preview of previews.values()) remove(preview);
      previews.clear();
      items = [];
    },
  };
}
