/** Standard WebRTC ICE entries. Only client TURN credentials belong here,
 * never a relay service's administrative/API token. Delivered through private
 * authenticated call admission, never embedded in the startup bundle.
 */
export interface VoiceIceServer { urls: string[]; username?: string; credential?: string }

export function parseVoiceIceServers(value: unknown): VoiceIceServer[] {
  if (!Array.isArray(value) || value.length > 6) throw new Error("Invalid voice ICE configuration");
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["urls", "username", "credential"].includes(key))) throw new Error("Invalid voice ICE server");
    const urls = typeof item.urls === "string" ? [item.urls] : item.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 8) throw new Error("Invalid voice ICE URLs");
    let turn = false;
    for (const url of urls) {
      if (typeof url !== "string" || url.length > 500) throw new Error("Invalid voice ICE URL");
      const match = /^(stun|turn|turns):([A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9a-fA-F:]+\])(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/.exec(url);
      if (!match || match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535) || match[1] === "stun" && match[4] || match[1] === "turns" && match[4] === "udp") throw new Error("Invalid voice ICE URL");
      turn ||= match[1] !== "stun";
    }
    const validSecret = (input: unknown) => typeof input === "string" && input.length > 0 && input.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(input);
    if (turn ? !validSecret(item.username) || !validSecret(item.credential) : item.username !== undefined || item.credential !== undefined) throw new Error("Invalid voice TURN credentials");
    return { urls: [...urls], ...(turn ? { username: item.username, credential: item.credential } : {}) };
  });
}
