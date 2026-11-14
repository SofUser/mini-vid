const MENU_PIP = "toggle-pip";
const MENU_BUTTON = "show-button";

function resetMenus(showButton) {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_PIP,
      title: "Вывести видео в картинку",
      contexts: ["page", "frame", "video", "action"],
    });
    chrome.contextMenus.create({
      id: MENU_BUTTON,
      title: "Показывать кнопку на видео",
      type: "checkbox",
      checked: showButton,
      contexts: ["action"],
    });
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { showButton } = await chrome.storage.local.get({ showButton: true });
  resetMenus(showButton !== false);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_BUTTON) {
    chrome.storage.local.set({ showButton: Boolean(info.checked) });
    return;
  }
  if (info.menuItemId === MENU_PIP && tab?.id) return togglePip(tab.id);
});

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id) return togglePip(tab.id);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-pip") return;
  const tabId =
    tab?.id ??
    (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  if (tabId) togglePip(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "PLAYER_WINDOW_STATE") return;
  if (!sender.tab || !/^[0-9a-f-]{36}$/.test(message.token || "") ||
      !["fullscreen", "normal", "maximized", "toggle"].includes(message.state)) {
    sendResponse({ ok: false });
    return;
  }
  const url = `about:blank#mini-vid-${message.token}`;
  (async () => {
    // Never guess by title/focus: another Chrome window must not be affected.
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] });
    const target = windows.find((win) => win.tabs?.length === 1 && win.tabs[0].url === url);
    if (!target) throw new Error("player-window-not-found");
    const state = message.state === "toggle"
      ? (target.state === "fullscreen" ? "normal" : "fullscreen")
      : message.state;
    const updated = await chrome.windows.update(target.id, { state });
    sendResponse({ ok: true, state: updated.state });
  })().catch(() => sendResponse({ ok: false }));
  return true;
});

async function flash(tabId, text) {
  try {
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: text === "!" ? "#b91c1c" : "#475569",
    });
    await chrome.action.setBadgeText({ tabId, text });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    }, 1800);
  } catch {
    /* вкладка уже закрыта */
  }
}

async function ensure(tabId) {
  const probe = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => ({
      ready: typeof globalThis.__MINI_VID__ === "object",
    }),
  });

  if (probe.some((row) => !row.result?.ready)) {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });
  }

}

async function toastTop(tabId, text) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (message) => globalThis.__MINI_VID__?.toast(message),
      args: [text],
    });
  } catch {
    /* нет доступа к странице */
  }
}

async function run(tabId, frameId, op, id) {
  const [row] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (operation, videoId) => globalThis.__MINI_VID__?.perform(operation, videoId),
    args: [op, id],
  });
  return row?.result ?? null;
}

async function togglePip(tabId) {
  try {
    await ensure(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => globalThis.__MINI_VID__?.report() ?? null,
    });

    const alive = results
      .map((row) => ({ frameId: row.frameId, data: row.result }))
      .filter((row) => row.data);

    const contextHits = alive.filter((row) => row.data.context && row.data.id);
    if (contextHits.length) {
      const hit = contextHits.reduce((best, row) =>
        row.data.score >= best.data.score ? row : best
      );
      await run(tabId, hit.frameId, "toggle", hit.data.id);
      return;
    }

    const pipHit = alive.find((row) => row.data.inPip);
    if (pipHit) {
      await run(tabId, pipHit.frameId, "exit", null);
      return;
    }

    const candidates = alive.filter((row) => row.data.id && !row.data.empty);
    if (!candidates.length) {
      await toastTop(tabId, "На этой странице нет видео");
      await flash(tabId, "?");
      return;
    }

    const best = candidates.reduce((lead, row) =>
      row.data.score >= lead.data.score ? row : lead
    );
    await run(tabId, best.frameId, "enter", best.data.id);
  } catch {
    await flash(tabId, "!");
  }
}
