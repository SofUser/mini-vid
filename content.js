(() => {
  // Auxiliary windows are controlled by the source frame, not by another instance.
  if (window.name.startsWith("mini-vid-player-") || globalThis.__MINI_VID__) return;

  let active = null;
  let hovered = null;
  let showButton = true;
  let hideTimer;
  let toastTimer;
  const ids = new WeakMap();
  let nextId = 1;
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
    button { position: fixed; display: none; width: 38px; height: 38px; border: 1px solid #ffffff55;
      border-radius: 9px; background: #0f172aeb; color: white; cursor: pointer; pointer-events: auto; font: 22px system-ui; }
    button:hover { background: #0891b2; }
    .toast { display: none; position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
      max-width: 90vw; padding: 12px; background: #0f172aee; color: white; border-radius: 9px; font: 14px system-ui; }
  `;
  const pipButton = document.createElement("button");
  pipButton.textContent = "▣";
    pipButton.title = "Мини-плеер";
  pipButton.setAttribute("aria-label", pipButton.title);
  const fullButton = document.createElement("button");
  fullButton.textContent = "⛶";
  fullButton.title = "Отдельный плеер на весь экран";
  fullButton.setAttribute("aria-label", fullButton.title);
  const notice = document.createElement("div");
  notice.className = "toast";
  notice.setAttribute("role", "status");
  shadow.append(style, pipButton, fullButton, notice);

  function mount() {
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen.tagName !== "VIDEO" ? fullscreen : document.documentElement;
    if (parent && host.parentNode !== parent) parent.append(host);
  }
  function toast(text) {
    mount();
    notice.textContent = text;
    notice.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { notice.style.display = "none"; }, 4500);
  }
  function videos(root = document) {
    const result = [...root.querySelectorAll("video")];
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) result.push(...videos(element.shadowRoot));
    }
    return result;
  }
  function id(video) {
    if (!ids.has(video)) ids.set(video, String(nextId++));
    return ids.get(video);
  }
  function score(video) {
    const box = video.getBoundingClientRect();
    const width = Math.max(0, Math.min(innerWidth, box.right) - Math.max(0, box.left));
    const height = Math.max(0, Math.min(innerHeight, box.bottom) - Math.max(0, box.top));
    return width * height + (!video.paused && !video.ended ? 1e7 : 0);
  }
  function best() {
    return videos().filter((video) => {
      const box = video.getBoundingClientRect();
      return box.width >= 80 && box.height >= 45 && video.readyState >= 1;
    }).sort((a, b) => score(b) - score(a))[0];
  }
  function report() {
    const video = active?.source || document.pictureInPictureElement || best();
    return { id: video ? id(video) : null, empty: !video, score: video ? score(video) : 0,
      inPip: Boolean(active || document.pictureInPictureElement), context: false };
  }
  function initialSize(video) {
    const ratio = video.videoWidth / video.videoHeight || 16 / 9;
    const width = Math.min(850, screen.availWidth * 0.75, screen.availHeight * 0.7 * ratio);
    return { width: Math.round(width), height: Math.round(width / ratio) };
  }
  function capture(video) {
    if (video.mediaKeys) throw new Error("protected");
    const stream = video.captureStream?.();
    if (!stream?.getVideoTracks().length) {
      stream?.getTracks().forEach((track) => track.stop());
      throw new Error("capture-unavailable");
    }
    return stream;
  }
  function closePlayer() {
    if (!active) return;
    const previous = active;
    active = null;
    previous.cleanup();
    if (!previous.window.closed) previous.window.close();
  }
  async function exitAny() {
    closePlayer();
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
  }

  function attachZoom(targetWindow, stage, preview) {
    let scale = 1;
    let x = 50;
    let y = 50;
    const apply = () => {
      preview.style.transformOrigin = `${x}% ${y}%`;
      preview.style.transform = `scale(${scale})`;
    };
    const point = (event) => {
      const box = stage.getBoundingClientRect();
      x = Math.max(0, Math.min(100, (event.clientX - box.left) / box.width * 100));
      y = Math.max(0, Math.min(100, (event.clientY - box.top) / box.height * 100));
    };
    stage.addEventListener("pointermove", (event) => { point(event); apply(); });
    stage.addEventListener("wheel", (event) => {
      event.preventDefault();
      point(event);
      scale = Math.max(1, Math.min(8, scale * Math.exp(-event.deltaY * 0.003)));
      apply();
    }, { passive: false });
    stage.addEventListener("dblclick", () => { scale = 1; apply(); });
    const onKey = (event) => {
      if (event.code !== "NumpadAdd" && event.code !== "NumpadSubtract") return;
      event.preventDefault();
      scale = Math.max(1, Math.min(8, scale * (event.code === "NumpadAdd" ? 1.25 : 0.8)));
      apply();
    };
    targetWindow.addEventListener("keydown", onKey);
    return () => targetWindow.removeEventListener("keydown", onKey);
  }

  function buildPlayer(targetWindow, source, stream, token = null) {
    const doc = targetWindow.document;
    doc.title = "Mini Vid";
    const sheet = doc.createElement("style");
    sheet.textContent = `
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: black; color: white; }
      .stage { position: absolute; inset: 0; overflow: hidden; }
      video { display: block; width: 100%; height: 100%; object-fit: contain; }
      .tools { position: fixed; top: 10px; right: 10px; display: flex; gap: 6px; z-index: 10;
        opacity: 0.15; transition: opacity .2s; }
      body:hover .tools, .tools:focus-within { opacity: 1; }
      button { border: 1px solid #ffffff55; border-radius: 8px; padding: 9px 12px;
        background: #0f172ae6; color: white; cursor: pointer; font: 13px system-ui; }
      .status { position: fixed; left: 12px; bottom: 12px; max-width: 90%;
        background: #0f172ae6; border-radius: 8px; padding: 8px; font: 13px system-ui; }
      .status:empty { display: none; }
    `;
    doc.head.append(sheet);
    const stage = doc.createElement("div");
    stage.className = "stage";
    const preview = doc.createElement("video");
    preview.muted = true;
    preview.autoplay = true;
    preview.playsInline = true;
    // Only the copy is displayed here. Never adopt the site's video element.
    preview.srcObject = stream;
    stage.append(preview);
    const tools = doc.createElement("div");
    tools.className = "tools";
    const status = doc.createElement("div");
    status.className = "status";
    const addButton = (text, action) => {
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.addEventListener("click", action);
      tools.append(button);
      return button;
    };
    const playButton = addButton(source.paused ? "Продолжить" : "Пауза", () => {
      if (source.paused) source.play().catch(() => { status.textContent = "Запустите видео на исходной вкладке"; });
      else source.pause();
    });
    const syncPlayback = () => {
      playButton.textContent = source.paused ? "Продолжить" : "Пауза";
      if (!source.paused) preview.play().catch(() => {});
    };
    // Re-capture after the site's player reloads its source (common for live streams).
    // Only restart the preview, never force the original out of an intentional pause.
    const refreshStream = () => {
      try {
        const replacement = capture(source);
        const previous = stream;
        stream = replacement;
        preview.srcObject = replacement;
        previous.getTracks().forEach((track) => track.stop());
        preview.play().catch(() => {});
      } catch {
        status.textContent = "Поток изменился. Попробуйте открыть мини-плеер заново.";
      }
    };
    source.addEventListener("play", syncPlayback);
    source.addEventListener("pause", syncPlayback);
    source.addEventListener("loadedmetadata", refreshStream);
    const fullButton = addButton("На весь экран", () => {
      if (!token) {
        openFullscreen(source, targetWindow);
      } else {
        setFullscreen();
      }
    });
    if (token) {
      addButton("Развернуть окно", () => setFullscreen("maximized"));
      addButton("Вернуть в мини-плеер", () => {
        enter(source).catch(() => toast("Не удалось открыть мини-плеер"));
      });
    }
    addButton("Закрыть", closePlayer);
    doc.body.append(stage, tools, status);
    const removeZoom = attachZoom(targetWindow, stage, preview);
    let cleaned = false;
    let state = "normal";
    let busy = false;
    async function setFullscreen(force) {
      if (busy) return;
      busy = true;
      try {
        const result = await chrome.runtime.sendMessage({
          type: "PLAYER_WINDOW_STATE", token,
          state: force || "toggle",
        });
        if (!result?.ok) throw new Error("window-state");
        state = result.state;
        fullButton.textContent = state === "fullscreen" ? "Уменьшить" : "На весь экран";
        status.textContent = "";
      } catch {
        status.textContent = "Не удалось развернуть окно. Нажмите F11 или разверните окно за заголовок.";
      } finally { busy = false; }
    }
    const onKey = (event) => {
      if (event.code === "KeyF" && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        if (token) setFullscreen();
        else openFullscreen(source, targetWindow);
      }
      if (event.code === "Escape" && token) setFullscreen("normal");
    };
    targetWindow.addEventListener("keydown", onKey);
    const onPlaying = () => { status.textContent = ""; };
    preview.addEventListener("playing", onPlaying);
    preview.addEventListener("error", () => {
      status.textContent = "Сайт не позволяет показать копию потока. Используйте обычный плеер сайта.";
    });
    preview.play().catch(() => { status.textContent = "Нажмите «Продолжить» или запустите видео на исходной вкладке"; });
    // Source continues to own audio and buffering. No automatic play/pause on close.
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      removeZoom();
      targetWindow.removeEventListener("keydown", onKey);
      source.removeEventListener("play", syncPlayback);
      source.removeEventListener("pause", syncPlayback);
      source.removeEventListener("loadedmetadata", refreshStream);
      preview.srcObject = null;
      stream.getTracks().forEach((track) => track.stop());
    };
    const session = { source, window: targetWindow, cleanup };
    targetWindow.addEventListener("pagehide", () => {
      cleanup();
      if (active === session) active = null;
    }, { once: true });
    return { session, setFullscreen };
  }

  function openFullscreen(source, fromWindow = window) {
    if (!source.isConnected) { toast("Плеер сайта заменил видео. Откройте его заново."); return; }
    let stream;
    let popup;
    try {
      stream = capture(source);
      const token = crypto.randomUUID();
      // A fresh, unguessable URL identifies ONLY this popup in the background.
      const features = `popup=yes,width=${screen.availWidth},height=${screen.availHeight}`;
      try {
        popup = fromWindow.open("about:blank", `mini-vid-player-${token}`, features);
      } catch { /* Some Chrome versions disallow window.open from Document PiP. */ }
      if (!popup && fromWindow !== window) {
        popup = window.open("about:blank", `mini-vid-player-${token}`, features);
      }
      if (!popup) throw new Error("popup-blocked");
      popup.location.hash = `mini-vid-${token}`;
      const player = buildPlayer(popup, source, stream, token);
      closePlayer();
      active = player.session;
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
      popup.focus();
      player.setFullscreen("fullscreen");
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (popup) popup.close();
      toast(error.message === "popup-blocked"
        ? "Разрешите всплывающие окна для сайта, затем нажмите ещё раз"
        : "Сайт запрещает копирование потока. Используйте полноэкранную кнопку плеера сайта.");
    }
  }

  async function enter(video, allowNative = true) {
    let stream;
    try {
      stream = capture(video);
      if (!window.documentPictureInPicture) throw new Error("no-document-pip");
      const targetWindow = await documentPictureInPicture.requestWindow(initialSize(video));
      closePlayer();
      active = buildPlayer(targetWindow, video, stream).session;
      targetWindow.focus();
      return "zoom";
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (!allowNative) throw error;
      // Protected/unsupported videos stay on the page and use native PiP.
      closePlayer();
      video.disablePictureInPicture = false;
      video.removeAttribute("disablepictureinpicture");
      await video.requestPictureInPicture();
      return "native";
    }
  }
  async function perform(operation, videoId) {
    try {
      if (operation === "exit") { await exitAny(); return { ok: true }; }
      const video = videos().find((item) => id(item) === videoId) || best();
      if (!video) { toast("На странице нет готового видео"); return { ok: false }; }
      if (operation === "toggle" && (active?.source === video || document.pictureInPictureElement === video)) {
        await exitAny(); return { ok: true };
      }
      const mode = await enter(video);
      toast(mode === "zoom" ? "В окне: «На весь экран» или F; нампад +/− — увеличение" : "Обычный PiP: сайт не поддерживает копию потока");
      return { ok: true, mode };
    } catch {
      toast("Не удалось открыть плеер. Запустите видео и нажмите кнопку на нём.");
      return { ok: false };
    }
  }
  function hide() {
    hovered = null;
    pipButton.style.display = fullButton.style.display = "none";
  }
  function place() {
    if (!hovered?.isConnected || !showButton) { hide(); return; }
    const rect = hovered.getBoundingClientRect();
    if (rect.width < 180 || rect.height < 100 || rect.bottom < 0 || rect.top > innerHeight) { hide(); return; }
    mount();
    const left = Math.max(8, Math.min(innerWidth - 46, rect.right - 50));
    const top = Math.max(8, Math.min(innerHeight - 96, rect.top + rect.height / 2 - 38));
    for (const [index, button] of [fullButton, pipButton].entries()) {
      button.style.left = `${left}px`;
      button.style.top = `${top + index * 44}px`;
      button.style.display = "block";
    }
  }
  for (const button of [pipButton, fullButton]) {
    button.addEventListener("pointerenter", () => clearTimeout(hideTimer));
    button.addEventListener("pointerleave", () => { hideTimer = setTimeout(hide, 600); });
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      button.addEventListener(type, (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (type !== "click" || !hovered) return;
        if (button === fullButton) openFullscreen(hovered);
        else perform("toggle", id(hovered));
      });
    }
  }
  document.addEventListener("pointerover", (event) => {
    const video = event.composedPath().find((node) => node.tagName === "VIDEO");
    if (!video || !showButton) return;
    clearTimeout(hideTimer);
    hovered = video;
    place();
  }, true);
  document.addEventListener("pointerout", (event) => {
    if (event.composedPath().includes(hovered)) hideTimer = setTimeout(hide, 600);
  }, true);
  window.addEventListener("resize", () => { if (hovered) place(); });
  document.addEventListener("scroll", () => { if (hovered) place(); }, true);
  document.addEventListener("fullscreenchange", () => { if (host.isConnected) mount(); });
  window.addEventListener("pagehide", closePlayer, { once: true });
  chrome.storage.local.get({ showButton: true }, (settings) => { showButton = settings.showButton !== false; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.showButton) return;
    showButton = changes.showButton.newValue !== false;
    if (!showButton) hide();
  });
  const intercepted = new WeakSet();
  document.addEventListener("mini-vid-pip-request", (event) => {
    const video = event.composedPath().find((node) => node instanceof HTMLVideoElement);
    const token = event.detail;
    if (!video || typeof token !== "string" || !/^[0-9a-f-]{36}$/.test(token)) return;
    const reply = (type, dimensions = {}) => video.dispatchEvent(new CustomEvent(
      "mini-vid-pip-response", { detail: JSON.stringify({ token, type, ...dimensions }) }
    ));
    reply("accepted");
    if (active?.source === video && !active.window.closed) {
      active.window.focus();
      reply("opened", { width: active.window.innerWidth, height: active.window.innerHeight });
      return;
    }
    if (intercepted.has(video)) { reply("failed"); return; }
    intercepted.add(video);
    // No native call here: the MAIN-world hook owns fallback, preventing recursion.
    enter(video, false).then(() => {
      reply("opened", { width: active?.window.innerWidth, height: active?.window.innerHeight });
    }, () => reply("failed")).finally(() => intercepted.delete(video));
  }, true);

  globalThis.__MINI_VID__ = { report, perform, toast };
})();
