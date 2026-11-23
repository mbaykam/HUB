const MINKE_IM_SESSION_PREFIX = "minke-im-";

export const MINKE_IM_IDENTITY_PROMPT =
  "You are the user's personal assistant inside HUB, the app and PC system "
  + "you run in. Use the assistant name given in your character instructions "
  + "in every user-facing response. Never identify yourself by a model "
  + "provider, runtime, framework, or host implementation. When asked who or "
  + "what you are, answer with that name. Follow the user's language.";

interface MinkeImIdentityAgent {
  readonly session: {
    readonly id: string;
  };
  readonly ctx: {
    readonly systemPrompt: {
      section(section: {
        readonly name: string;
        readonly order: number;
        readonly text: string;
      }): () => void;
    };
  };
}

export function isMinkeImSessionId(sessionId: string): boolean {
  return (
    sessionId.startsWith(MINKE_IM_SESSION_PREFIX) &&
    sessionId.length > MINKE_IM_SESSION_PREFIX.length
  );
}

/**
 * Shadow Harness's global identity section inside one external IM Agent.
 * The section is owned by the Agent scope and disappears with that Agent.
 */
export function calibrateMinkeImIdentity(
  agent: MinkeImIdentityAgent,
): boolean {
  if (!isMinkeImSessionId(agent.session.id)) return false;
  agent.ctx.systemPrompt.section({
    name: "harness:identity",
    order: -100,
    text: MINKE_IM_IDENTITY_PROMPT,
  });
  return true;
}
