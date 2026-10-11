import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { splitTelegramText, TelegramTransportError, type TelegramTransport } from "@lencx/minke-im-telegram";
import type { GatewayCipher, GatewayProviderSession, GatewayAttemptOutcome } from "@lencx/minke-im-gateway";

const ENCODING = "hub-telegram-live-reply-v1";
export interface TelegramLiveReply {
  readonly kind: "hub-live-reply";
  readonly key: string;
  readonly revision: number;
  readonly final: boolean;
  readonly markdown: string;
}
interface Receipt { ids: string[]; hashes: string[]; revision: number; final: boolean; attachmentId?: string; }
export interface TelegramReplyStore { get(key: string): Receipt | undefined; set(key: string, value: Receipt): void; }

/** Message IDs and content hashes are private; receipt recovery never re-sends
 * a known chunk. The ordinary gateway still owns uncertain sends/retries. */
export class TelegramReplyReceipts implements TelegramReplyStore {
  readonly #records = new Map<string, Receipt>(); #loaded = false;
  readonly path: string; readonly cipher: () => GatewayCipher;
  constructor(path: string, cipher: () => GatewayCipher) { this.path = path; this.cipher = cipher; }
  #load() {
    if (this.#loaded) return;
    try {
      const rows = JSON.parse(Buffer.from(this.cipher().open(readFileSync(this.path), "hub-telegram-replies")).toString("utf8"));
      if (!Array.isArray(rows)) throw new Error("Invalid Telegram reply receipts");
      for (const [key, value] of rows) {
        if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key) || !value || !Array.isArray(value.ids) || value.ids.length > 8 || !value.ids.every((id: unknown) => typeof id === "string" && /^[1-9][0-9]*$/.test(id)) || !Array.isArray(value.hashes) || !value.hashes.every((s: unknown) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s)) || !Number.isSafeInteger(value.revision) || typeof value.final !== "boolean" || (value.attachmentId !== undefined && !/^[1-9][0-9]*$/.test(value.attachmentId))) throw new Error("Invalid Telegram reply receipt");
        this.#records.set(key, value);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.#loaded = true;
  }
  get(key: string) { this.#load(); const value = this.#records.get(key); return value && { ...value, ids: [...value.ids], hashes: [...value.hashes] }; }
  set(key: string, value: Receipt) {
    this.#load(); this.#records.delete(key); this.#records.set(key, { ...value, ids: [...value.ids], hashes: [...value.hashes] });
    if (this.#records.size > 1000) this.#records.delete(this.#records.keys().next().value!);
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = this.path + ".tmp";
    writeFileSync(temp, this.cipher().seal(Buffer.from(JSON.stringify([...this.#records])), "hub-telegram-replies"), { mode: 0o600 }); renameSync(temp, this.path);
  }
}
function parseReply(value: unknown): TelegramLiveReply | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as TelegramLiveReply;
  if (v.kind !== "hub-live-reply" || !/^[a-f0-9]{64}$/.test(v.key) || !Number.isSafeInteger(v.revision) || v.revision < 0 || typeof v.final !== "boolean" || typeof v.markdown !== "string" || !v.markdown.trim() || v.markdown.length > 128000) return;
  return { kind: v.kind, key: v.key, revision: v.revision, final: v.final, markdown: v.markdown };
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function failure(error: unknown): GatewayAttemptOutcome {
  if (!(error instanceof TelegramTransportError) || error.effect === "unknown") return { status: "uncertain", errorCode: error instanceof TelegramTransportError ? error.code : "reply-store-or-transport" };
  if (error.code === "aborted") return { status: "deferred", reasonCode: error.code };
  if (error.code === "credential-invalid") return { status: "rejected", errorCode: error.code, terminal: "credential-invalid" };
  if (error.retryable) return { status: "retry", errorCode: error.code, retryAfterMs: error.retryAfterMs ?? 0 };
  return { status: "rejected", errorCode: error.code };
}

export function withTelegramLiveReplies(provider: GatewayProviderSession, transport: TelegramTransport, store: TelegramReplyStore): GatewayProviderSession {
  const wrapped: GatewayProviderSession = {
    ...provider,
    async prepare(delivery, options) {
      const cached = delivery.prepared?.payload as { encoding?: string; operationId?: string; recipientId?: string; reply?: unknown } | undefined;
      if (cached?.encoding === ENCODING) {
        const reply = parseReply(cached.reply);
        return reply && cached.operationId === delivery.operationId && cached.recipientId === delivery.recipientId ? { status: "ready", preparedPayload: cached } : { status: "rejected", errorCode: "invalid-live-reply" };
      }
      const reply = parseReply(delivery.payload);
      if (!reply) return await provider.prepare(delivery, options);
      return { status: "ready", preparedPayload: { encoding: ENCODING, operationId: delivery.operationId, recipientId: delivery.recipientId, reply } };
    },
    async deliver(attempt, options) {
      const prepared = attempt.preparedPayload as { encoding?: string; operationId?: string; recipientId?: string; reply?: unknown };
      if (prepared?.encoding !== ENCODING) return await provider.deliver(attempt, options);
      const reply = parseReply(prepared.reply);
      if (!reply || prepared.operationId !== attempt.operationId || prepared.recipientId !== attempt.recipientId) return { status: "rejected", errorCode: "invalid-live-reply" };
      const key = hash(JSON.stringify([provider.account.accountKey, provider.account.generation, attempt.recipientId, reply.key]));
      try {
        const receipt = store.get(key) ?? { ids: [], hashes: [], revision: -1, final: false };
        if (reply.revision <= receipt.revision || (receipt.final && !reply.final)) return { status: "accepted", providerReceiptId: `${attempt.recipientId}:${receipt.ids[0]}` };
        const all = splitTelegramText(reply.markdown), chunks = all.slice(0, 8);
        for (const [index, markdown] of chunks.entries()) {
          const digest = hash(markdown);
          if (receipt.hashes[index] === digest && receipt.ids[index]) continue;
          let messageId: string | undefined = receipt.ids[index];
          if (messageId) {
            try { await transport.editRichMarkdown({ chatId: attempt.recipientId, messageId, markdown }, options); }
            catch (error) {
              if (!(error instanceof TelegramTransportError)) throw error;
              if (error.code === "message-not-found") messageId = undefined;
              else if (error.code !== "message-not-modified") throw error;
            }
          }
          if (!messageId) messageId = (await transport.sendRichMarkdown({ chatId: attempt.recipientId, markdown }, options)).messageId;
          receipt.ids[index] = messageId; receipt.hashes[index] = digest; store.set(key, receipt);
        }
        if (all.length > 8 && !receipt.attachmentId) {
          receipt.attachmentId = (await transport.sendDocument({ chatId: attempt.recipientId, caption: "Yanıtın tamamı ekte.", document: { kind: "bytes", bytes: new TextEncoder().encode(reply.markdown), fileName: "hub-response.md", mimeType: "text/markdown" } }, options)).messageId; store.set(key, receipt);
        }
        receipt.revision = reply.revision; receipt.final = reply.final; store.set(key, receipt);
        return { status: "accepted", providerReceiptId: `${attempt.recipientId}:${receipt.ids[0]}` };
      } catch (error) { return failure(error); }
    },
  };
  return Object.freeze(wrapped);
}
