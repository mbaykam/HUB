/** Opaque receipts keep original files out of chat text and out of URLs. */
export const UPLOAD_MAX_BYTES = 25_000_000;
export const UPLOAD_MAX_FILES = 8;
export const uploadId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uploadSession = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export interface UploadReceipt {
  id: string;
  sessionId: string;
  assetId: string;
  name: string;
  bytes: number;
  mediaType: string;
  image?: Record<string, unknown>;
}
export function uploadMarkers(text: string): string[] {
  return [...new Set([...text.matchAll(/\{HUB_ATTACHMENT:([0-9a-f-]{36})\}/gi)].map(m => m[1]!).filter(id => uploadId.test(id)))].slice(0, UPLOAD_MAX_FILES);
}
export function uploadMarker(id: string) { return `{HUB_ATTACHMENT:${id}}`; }
