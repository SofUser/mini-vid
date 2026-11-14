(() => {
  if (window.name.startsWith("mini-vid-player-") || globalThis.__MINI_VID_HOOK__) return;
  globalThis.__MINI_VID_HOOK__ = true;
  const prototype = HTMLVideoElement.prototype;
  const nativeRequest = prototype.requestPictureInPicture;
  if (typeof nativeRequest !== "function") return;

  // Synchronous DOM events preserve the click's transient user activation.
  // These messages carry no privileged extension operations.
  prototype.requestPictureInPicture = function requestPictureInPicture() {
    const video = this;
    if (!(video instanceof HTMLVideoElement)) return nativeRequest.call(video);
    const token = crypto.randomUUID();
    let accepted = false;
    let timer;
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("mini-vid-pip-response", onResponse);
    };
    const onResponse = (event) => {
      let message;
      try { message = JSON.parse(event.detail); } catch { return; }
      if (message.token !== token) return;
      if (message.type === "accepted") { accepted = true; return; }
      cleanup();
      if (message.type === "opened") {
        // Document PiP has no native PictureInPictureWindow for the source.
        // Supply the common size/event interface; do not forge document state.
        const handle = new EventTarget();
        Object.defineProperties(handle, {
          width: { value: message.width || 0 },
          height: { value: message.height || 0 },
        });
        resolveResult(handle);
      } else {
        // The content script did not open a window. Retain the site's original
        // API behavior, including native errors for DRM/policy restrictions.
        Promise.resolve().then(() => nativeRequest.call(video)).then(resolveResult, rejectResult);
      }
    };
    video.addEventListener("mini-vid-pip-response", onResponse);
    timer = setTimeout(() => {
      cleanup();
      rejectResult(new DOMException("Mini Vid did not respond", "AbortError"));
    }, 15000);
    video.dispatchEvent(new CustomEvent("mini-vid-pip-request", {
      bubbles: true, composed: true, detail: token,
    }));
    if (!accepted) {
      cleanup();
      return nativeRequest.call(video);
    }
    return result;
  };
})();
