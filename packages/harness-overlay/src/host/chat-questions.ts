/**
 * Questions to the user go in the conversation itself.
 *
 * The harness's ask_user_question tool waits for an answer from whichever
 * client registered an answerer, which on this PC is HUB's own desktop window.
 * The user is usually on the iPhone, Telegram or a voice call, none of which
 * show that prompt, so the turn hung until someone answered on the PC. Instead
 * the tool returns at once and tells the assistant to ask in its reply and end
 * the turn; the user's next message, from any device, is the answer.
 */
export const CHAT_QUESTIONS_GUIDE = "When you need the user's choice, approval or missing detail, ask it plainly in your reply (offer the options in the text) and end your turn. Their next message is the answer. Do not call ask_user_question; it cannot reach the user on their phone, Telegram or a voice call.";

export class ChatQuestionRedirect extends Error {
  readonly code = "ASK_IN_CHAT";
  constructor(questions: readonly {question?: string; header?: string; options?: readonly {label?: string}[]}[]) {
    const asked = questions.map(q => {
      const options = (q.options ?? []).map(o => o.label).filter(Boolean);
      return `"${q.question ?? q.header ?? "your question"}"${options.length ? ` (options: ${options.join(" / ")})` : ""}`;
    }).join("; ");
    super(`The user cannot see this question prompt on the device they are using. Ask it in your reply instead: ${asked}. Then end your turn and wait; their next message is the answer. Do not assume an answer and do not retry this tool.`);
    this.name = "UserQuestionError";
  }
}

export function installChatQuestions(ctx: any): () => void {
  const offAnswerer = ctx.on?.("user-questions/request", (request: any) => {
    throw new ChatQuestionRedirect(Array.isArray(request?.questions) ? request.questions : []);
  }, {prepend: true});
  const offGuide = ctx.systemPrompt?.section?.({name: "hub:chat-questions", order: 91, text: CHAT_QUESTIONS_GUIDE});
  return () => { offGuide?.(); offAnswerer?.(); };
}
