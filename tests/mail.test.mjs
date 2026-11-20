import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {MailStore, installMail, mailtoLink, validRecipients} from "../packages/harness-overlay/src/host/mail.ts";

test("recipients are plain addresses and drafts become a mailto link for the phone", () => {
  assert.equal(validRecipients("a@x.com; Bob <b@y.org>"), "a@x.com, Bob <b@y.org>");
  assert.throws(() => validRecipients("not an address"));
  const link = mailtoLink({to: "a@x.com, b@y.org", cc: "", subject: "Stand: 3 offers", body: "Hi,\nsee below & reply"});
  assert.equal(link, "mailto:a%40x.com,b%40y.org?subject=Stand%3A%203%20offers&body=Hi%2C%0Asee%20below%20%26%20reply");
});

test("drafts are kept per chat and can be dismissed", async () => {
  const store = new MailStore(await mkdtemp(join(tmpdir(), "hub-mail-")));
  await store.load();
  const draft = await store.addDraft({sessionId: "s1", to: "a@x.com", cc: "", subject: "Hi", body: "Text"});
  await store.dismiss(draft.id);
  const again = new MailStore(store.root); await again.load();
  assert.equal(again.drafts[0].dismissed, true);
});

const harness = (mainSelected = true) => {
  const tools = {};
  const ctx = {
    tools: {register(t) { tools[t.name] = t; return () => {}; }},
    systemPrompt: {section() { return () => {}; }},
    webServer: {register() { return () => {}; }},
    connection: {requestRejection() { return undefined; }},
  };
  const characters = {store: {snapshot: () => ({mainId: "main"})}, effectiveCharacter: () => ({id: mainSelected ? "main" : "free"})};
  installMail(ctx, characters);
  return tools;
};
const chat = (id, origin) => ({agent: {session: {header: {id, origin}}}, signal: AbortSignal.timeout(1000)});

test("mail is refused to helpers, to other models and without an account", async () => {
  const tools = harness(true);
  await assert.rejects(tools.hub_mail_search.execute({}, chat("sub", "subagent")), /not in helpers/);
  await assert.rejects(tools.hub_mail_search.execute({}, chat("session-1")), /No mail account|Smart model/);
  const other = harness(false);
  await assert.rejects(other.hub_mail_draft.execute({to: "a@x.com", subject: "s", body: "b"}, chat("session-1")), /Smart model/);
  assert.equal(tools.hub_mail_send, undefined, "there is no send tool");
});

test("the IMAP worker turns an HTML email into readable text and lists attachments", async () => {
  const {execFileSync} = await import("node:child_process");
  const python = join(process.env.USERPROFILE ?? process.env.HOME, ".dsh", "runtimes", "pipecat", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const script = new URL("../packages/harness-overlay/voice/mail_imap.py", import.meta.url);
  const raw = "From: Ece <ece@example.com>\r\nSubject: =?utf-8?q?Stand_fiyat=C4=B1?=\r\nDate: Thu, 19 Nov 2026 10:00:00 +0300\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Merhaba,</p><p>Fiyat: <b>18.000 TL</b></p><script>x()</script>\r\n--b\r\nContent-Type: application/pdf; name=teklif.pdf\r\nContent-Disposition: attachment; filename=teklif.pdf\r\n\r\nJVBERi0=\r\n--b--\r\n";
  const code = `import sys,json,email\nsys.path.insert(0,${JSON.stringify(join(script.pathname.replace(/^\/(\w:)/, "$1"), ".."))})\nimport mail_imap as m\nfrom email.policy import default\nmsg=email.message_from_bytes(sys.stdin.buffer.read(),policy=default)\nprint(json.dumps({"text":m.text_of(msg),"att":m.attachments_of(msg),"subject":m.decoded_header(msg,"Subject")}))`;
  let out;
  try { out = JSON.parse(execFileSync(python, ["-I", "-c", code], {input: raw}).toString("utf8")); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  assert.match(out.text, /Merhaba,\s*\n+\s*Fiyat: 18\.000 TL/);
  assert.doesNotMatch(out.text, /x\(\)/);
  assert.equal(out.subject, "Stand fiyatı");
  assert.deepEqual(out.att, [{name: "teklif.pdf", type: "application/pdf"}]);
});
