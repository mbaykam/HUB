import test from "node:test";
import assert from "node:assert/strict";
import {installChatQuestions, CHAT_QUESTIONS_GUIDE} from "../packages/harness-overlay/src/host/chat-questions.ts";

test("questions are redirected into the conversation with the options spelled out", () => {
  let handler, options, section;
  const dispose = installChatQuestions({
    on(name, fn, opts) { assert.equal(name, "user-questions/request"); handler = fn; options = opts; return () => { handler = undefined; }; },
    systemPrompt: {section(value) { section = value; return () => { section = undefined; }; }},
  });
  assert.equal(options.prepend, true);
  assert.equal(section.text, CHAT_QUESTIONS_GUIDE);
  assert.throws(() => handler({questions: [{question: "Close Notepad without saving?", options: [{label: "Yes"}, {label: "No"}]}]}),
    error => error.code === "ASK_IN_CHAT" && /Ask it in your reply instead: "Close Notepad without saving\?" \(options: Yes \/ No\)/.test(error.message) && /end your turn/.test(error.message));
  dispose();
  assert.equal(handler, undefined);
  assert.equal(section, undefined);
});
