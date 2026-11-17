import assert from "node:assert/strict";
import test from "node:test";
import {installDesktopControl, parseKeyCombo, toScreen, DESKTOP_LOOK_TOOL, DESKTOP_ACT_TOOL} from "../packages/harness-overlay/src/host/desktop-control.ts";

// A 2x1 PNG header is enough: the tool only reads the size.
function pngOf(width, height) {
  const data = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data, 0);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function setup({vision = true} = {}) {
  const tools = new Map();
  const commands = [];
  const sections = [];
  const input = {
    async info() { return {width: 2736, height: 1536, cursorX: 10, cursorY: 20}; },
    async windows() { return [{handle: "42", title: "Notepad", process: "notepad", left: 0, top: 0, width: 800, height: 600, focused: true, minimized: false}]; },
    async run(command) { commands.push(command); },
    dispose() {},
  };
  const dispose = installDesktopControl({
    tools: {register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); }},
    systemPrompt: {section(value) { sections.push(value); return () => {}; }},
  }, {
    async capture() { return pngOf(1368, 768); },
    input,
    async vision() { return vision; },
    async save(data) { return {attachmentId: "sha256:" + "a".repeat(64), bytes: data.length, mediaType: "image/png"}; },
  });
  const agent = {id: "agent-1", session: {header: {id: "session-1"}, snapshotEvents: () => []}};
  const exec = () => ({agent, signal: new AbortController().signal});
  return {tools, commands, sections, dispose, exec};
}

test("key combinations map to virtual keys and reject unknown names", () => {
  assert.deepEqual(parseKeyCombo("ctrl+shift+t"), {keys: [0x11, 0x10, 0x54], extended: [false, false, false]});
  assert.deepEqual(parseKeyCombo("Alt + F4").keys, [0x12, 0x73]);
  assert.equal(parseKeyCombo("up").extended[0], true);
  assert.throws(() => parseKeyCombo("hyper+q"), /Unknown key "hyper"/);
  assert.throws(() => parseKeyCombo("a+b+c+d+e+f"), /up to five/);
});

test("screenshot points scale to physical screen pixels and stay on screen", () => {
  assert.deepEqual(toScreen(684, 384, {width: 1368, height: 768}, {width: 2736, height: 1536}), {x: 1368, y: 768});
  assert.deepEqual(toScreen(1368, 768, {width: 1368, height: 768}, {width: 2736, height: 1536}), {x: 2735, y: 1535});
  assert.throws(() => toScreen(1500, 10, {width: 1368, height: 768}, {width: 2736, height: 1536}), /outside/);
});

test("acting needs a look first, then uses that look's pixel grid", async () => {
  const {tools, commands, sections, exec, dispose} = setup();
  const act = tools.get(DESKTOP_ACT_TOOL), look = tools.get(DESKTOP_LOOK_TOOL);
  assert.ok(sections.some(section => /hub_desktop_look/.test(section.text)));
  await assert.rejects(act.execute({action: "click", x: 5, y: 5}, exec()), /Look at the screen/);
  const run = exec();
  const value = await look.execute({}, run);
  assert.equal(value.screenshot.width, 1368);
  assert.equal(value.windows[0].handle, "42");
  const content = look.finalizeContent(run, {isError: false});
  assert.equal(content[1].type, "image");
  await act.execute({action: "double_click", x: 684, y: 384}, exec());
  await act.execute({action: "keys", keys: "ctrl+l"}, exec());
  await act.execute({action: "type", text: "hello"}, exec());
  await act.execute({action: "focus", window: "42"}, exec());
  await act.execute({action: "scroll", amount: -3}, exec());
  assert.deepEqual(commands, [
    {op: "click", x: 1368, y: 768, button: "left", count: 2},
    {op: "keys", keys: [0x11, 0x4c], extended: [false, false]},
    {op: "type", text: "hello"},
    {op: "focus", handle: "42"},
    {op: "scroll", x: 10, y: 20, amount: -3, horizontal: false},
  ]);
  await assert.rejects(act.execute({action: "focus", window: "not-a-handle"}, exec()), /window handle/);
  await assert.rejects(act.execute({action: "explode"}, exec()), /Choose an action/);
  dispose();
  assert.equal(tools.size, 0);
});

test("a model without image input gets the window list instead of a screenshot", async () => {
  const {tools, exec} = setup({vision: false});
  const value = await tools.get(DESKTOP_LOOK_TOOL).execute({}, exec());
  assert.match(value.screenshot, /does not read images/);
  assert.equal(value.windows.length, 1);
});
