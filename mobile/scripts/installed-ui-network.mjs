/** Serialized into the installed UI before bootstrap; deliberately import-free. */
export function installInstalledUINetwork(expectedCompatibility, scope = globalThis) {
  if (!/^[a-f0-9]{64}$/.test(expectedCompatibility)) throw new Error("Invalid installed UI compatibility");
  const originalFetch = scope.fetch;
  const origin = new URL(scope.location.href).origin;
  const now = () => (scope.Date ?? Date).now();
  let inflight, verifiedUntil = 0, retryAfter = 0, lastFailure;
  function ready() {
    if (now() < verifiedUntil) return Promise.resolve();
    if (inflight) return inflight;
    if (now() < retryAfter) return Promise.reject(lastFailure);
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = scope.setTimeout(() => {
        const error = new Error("Host compatibility verification timed out");
        controller.abort(error); reject(error);
      }, 8000);
    });
    const verify = async () => {
      const response = await originalFetch.call(scope, "/api/hub/ui/status", {
        method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { accept: "application/json" }, signal: controller.signal,
      });
      if (response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")) {
        throw new Error("Sign in to the matching HUB host before connecting");
      }
      const value = await response.json();
      if (value?.schema !== 1 || !/^[a-f0-9]{64}$/.test(value.compatibility ?? "") || value.compatibility !== expectedCompatibility) {
        throw new Error("Installed UI requires a matching HUB host");
      }
    };
    inflight = Promise.race([verify(), timeout]).then(() => {
      verifiedUntil = now() + 30000; retryAfter = 0; lastFailure = undefined;
    }, error => {
      verifiedUntil = 0; retryAfter = now() + 5000; lastFailure = error;
      throw error;
    }).finally(() => { scope.clearTimeout(timer); inflight = undefined; });
    return inflight;
  }
  scope.__HUB_INSTALLED_UI_READY__ = ready;
  scope.fetch = function(input, init) {
    let url;
    try { url = new URL(input?.url ?? String(input), scope.location.href); }
    catch (error) { return Promise.reject(error); }
    if (url.origin !== origin || url.pathname === "/api/hub/ui/status") return originalFetch.call(scope, input, init);
    const signal = init && Object.hasOwn(init, "signal") ? init.signal : input?.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      let finished = false;
      const aborted = () => { finished = true; reject(signal.reason); };
      signal?.addEventListener("abort", aborted, { once: true });
      ready().then(() => {
        signal?.removeEventListener("abort", aborted);
        if (finished || signal?.aborted) { if (!finished) reject(signal.reason); return; }
        finished = true;
        // Pass the exact caller objects once. Never consume, clone, retry or
        // persist request bodies, including read-only POSTs and model tasks.
        resolve(originalFetch.call(scope, input, init));
      }, error => {
        signal?.removeEventListener("abort", aborted);
        if (!finished) { finished = true; reject(error); }
      });
    });
  };
}
