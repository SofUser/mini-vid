const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const token = '12345678-1234-1234-1234-123456789abc';

function hookHarness(replyType) {
  let nativeCalls = 0;
  class Video extends EventTarget {
    async requestPictureInPicture() { nativeCalls++; return { native: true }; }
  }
  class Custom extends Event {
    constructor(type, options) { super(type, options); this.detail = options.detail; }
  }
  const context = {
    window: { name: '' }, HTMLVideoElement: Video, EventTarget, CustomEvent: Custom,
    crypto: { randomUUID: () => token }, setTimeout, clearTimeout, DOMException,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'page-hook.js'), 'utf8'), context);
  const video = new Video();
  if (replyType) video.addEventListener('mini-vid-pip-request', (event) => {
    const reply = (type) => video.dispatchEvent(new Custom('mini-vid-pip-response', {
      detail: JSON.stringify({ token: event.detail, type, width: 800, height: 450 }),
    }));
    reply('accepted');
    reply(replyType);
  });
  return { video, nativeCalls: () => nativeCalls };
}

test('site PiP request is replaced by custom player without native call', async () => {
  const h = hookHarness('opened');
  const handle = await h.video.requestPictureInPicture();
  assert.equal(handle.width, 800);
  assert.equal(handle.height, 450);
  assert.equal(h.nativeCalls(), 0);
});

test('site PiP request retains native fallback when custom player fails', async () => {
  const h = hookHarness('failed');
  assert.equal((await h.video.requestPictureInPicture()).native, true);
  assert.equal(h.nativeCalls(), 1);
});

test('site PiP works normally when content script is not ready', async () => {
  const h = hookHarness();
  assert.equal((await h.video.requestPictureInPicture()).native, true);
  assert.equal(h.nativeCalls(), 1);
});

function backgroundHarness(windows) {
  let handler;
  const updates = [];
  const event = { addListener() {} };
  const chrome = {
    runtime: { onInstalled: event, onMessage: { addListener(fn) { handler = fn; } } },
    contextMenus: { onClicked: event }, action: { onClicked: event }, commands: { onCommand: event },
    windows: {
      async getAll() { return windows; },
      async update(id, options) { updates.push({ id, ...options }); return options; },
    },
  };
  vm.runInNewContext(background, { chrome });
  return {
    updates,
    send(message, sender = { tab: { id: 1 } }) {
      return new Promise((resolve) => handler(message, sender, resolve));
    },
  };
}

test('fullscreen targets the exact token, not a focused or similarly titled window', async () => {
  const harness = backgroundHarness([
    { id: 2, focused: true, tabs: [{ title: 'Mini Vid', url: 'https://example.com' }] },
    { id: 3, state: 'normal', tabs: [{ url: `about:blank#mini-vid-${token}` }] },
  ]);
  const result = await harness.send({ type: 'PLAYER_WINDOW_STATE', token, state: 'fullscreen' });
  assert.equal(result.ok, true);
  assert.equal(harness.updates[0].id, 3);
  assert.equal(harness.updates[0].state, 'fullscreen');
});

test('missing popup and malformed requests do not change other windows', async () => {
  const harness = backgroundHarness([{ id: 2, focused: true, tabs: [{ title: 'Mini Vid' }] }]);
  for (const message of [
    { token, state: 'fullscreen' },
    { token: 'bad', state: 'fullscreen' },
    { token, state: 'minimized' },
  ]) {
    assert.equal((await harness.send({ type: 'PLAYER_WINDOW_STATE', ...message })).ok, false);
  }
  assert.equal(harness.updates.length, 0);
});

test('toggle reads actual fullscreen state, including changes made with F11', async () => {
  const harness = backgroundHarness([{ id: 3, state: 'fullscreen', tabs: [{ url: `about:blank#mini-vid-${token}` }] }]);
  const result = await harness.send({ type: 'PLAYER_WINDOW_STATE', token, state: 'toggle' });
  assert.equal(result.state, 'normal');
});

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.isConnected = true;
  }
  append(...items) { this.children.push(...items); }
  attachShadow() { this.shadow = new Element(); return this.shadow; }
  setAttribute() {}
  removeAttribute() {}
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== fn); }
  async fire(type, options = {}) {
    for (const handler of [...(this.listeners[type] || [])]) {
      await handler({ preventDefault() {}, stopPropagation() {}, ...options });
    }
  }
  async play() { this.paused = false; }
  pause() { this.paused = true; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 450, width: 800, height: 450 }; }
}
function playerHarness({ protectedVideo = false, blockedPopup = false } = {}) {
  const messages = [];
  const streams = [];
  const makeWindow = () => {
    const win = new Element();
    const doc = new Element();
    doc.head = new Element('head');
    doc.body = new Element('body');
    doc.documentElement = new Element('html');
    doc.createElement = (tag) => new Element(tag);
    doc.querySelectorAll = () => [];
    win.document = doc;
    win.name = '';
    win.location = {};
    win.focus = () => {};
    win.close = () => { win.closed = true; win.fire('pagehide'); };
    return win;
  };
  const main = makeWindow();
  const pip = makeWindow();
  const popup = makeWindow();
  main.open = pip.open = () => blockedPopup ? null : popup;
  main.documentPictureInPicture = { async requestWindow() { pip.closed = false; return pip; } };
  const source = new Element('video');
  source.videoWidth = 1920;
  source.videoHeight = 1080;
  source.readyState = 4;
  source.paused = false;
  source.mediaKeys = protectedVideo ? {} : null;
  source.captureStream = () => {
    const track = { stopped: false, stop() { this.stopped = true; } };
    const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
    streams.push(stream);
    return stream;
  };
  source.requestPictureInPicture = async () => { main.document.pictureInPictureElement = source; };
  main.document.exitPictureInPicture = async () => { main.document.pictureInPictureElement = null; };
  main.document.querySelectorAll = (selector) => selector === 'video' ? [source] : [];
  const chrome = {
    runtime: { async sendMessage(message) { messages.push(message); return { ok: true, state: message.state }; } },
    storage: { local: { get(defaults, callback) { callback(defaults); } }, onChanged: { addListener() {} } },
  };
  const context = vm.createContext({ window: main, document: main.document, chrome,
    documentPictureInPicture: main.documentPictureInPicture,
    innerWidth: 1920, innerHeight: 1080, screen: { availWidth: 1920, availHeight: 1040 },
    crypto: { randomUUID: () => token }, setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(content, context);
  const tools = (win) => win.document.body.children.find((item) => item.className === 'tools');
  const button = (win, text) => tools(win).children.find((item) => item.textContent === text);
  return { api: context.__MINI_VID__, source, pip, popup, streams, messages, button, main };
}

test('mini → fullscreen → mini keeps original video in place and stops only old copies', async () => {
  const h = playerHarness();
  assert.equal((await h.api.perform('enter')).mode, 'zoom');
  assert.equal(h.pip.document.body.children.some((item) => item.children.includes(h.source)), false);
  await h.button(h.pip, 'На весь экран').fire('click');
  assert.equal(h.pip.closed, true);
  assert.equal(h.popup.closed, undefined);
  assert.equal(h.source.paused, false);
  assert.equal(h.streams[0].getTracks()[0].stopped, true);
  assert.equal(h.streams[1].getTracks()[0].stopped, false);
  assert.equal(h.messages[0].state, 'fullscreen');
  await h.button(h.popup, 'Вернуть в мини-плеер').fire('click');
  await new Promise(setImmediate);
  assert.equal(h.popup.closed, true);
  assert.equal(h.source.paused, false);
  assert.equal(h.streams[1].getTracks()[0].stopped, true);
  assert.equal(h.streams[2].getTracks()[0].stopped, false);
  await h.api.perform('exit');
  assert.equal(h.streams[2].getTracks()[0].stopped, true);
});

test('blocked popup leaves working mini-player intact', async () => {
  const h = playerHarness({ blockedPopup: true });
  await h.api.perform('enter');
  await h.button(h.pip, 'На весь экран').fire('click');
  assert.equal(h.pip.closed, false);
  assert.equal(h.streams[0].getTracks()[0].stopped, false);
  assert.equal(h.streams[1].getTracks()[0].stopped, true);
  assert.equal(h.messages.length, 0);
});

test('zoom and source pause controls work in the detached player', async () => {
  const h = playerHarness();
  await h.api.perform('enter');
  await h.button(h.pip, 'На весь экран').fire('click');
  const stage = h.popup.document.body.children.find((item) => item.className === 'stage');
  const preview = stage.children[0];
  await stage.fire('pointermove', { clientX: 200, clientY: 100 });
  await h.popup.fire('keydown', { code: 'NumpadAdd' });
  assert.equal(preview.style.transform, 'scale(1.25)');
  assert.equal(preview.style.transformOrigin, '25% 22.22222222222222%');
  await stage.fire('dblclick');
  assert.equal(preview.style.transform, 'scale(1)');
  await h.button(h.popup, 'Пауза').fire('click');
  assert.equal(h.source.paused, true);
  await h.api.perform('exit');
  assert.equal(h.source.paused, true, 'closing does not override intentional pause');
});

test('source reload reconnects preview without unpausing original video', async () => {
  const h = playerHarness();
  await h.api.perform('enter');
  h.source.pause();
  await h.source.fire('loadedmetadata');
  assert.equal(h.streams[0].getTracks()[0].stopped, true);
  assert.equal(h.streams[1].getTracks()[0].stopped, false);
  assert.equal(h.source.paused, true);
  await h.api.perform('exit');
  assert.equal(h.streams[1].getTracks()[0].stopped, true);
  assert.equal(h.source.listeners.loadedmetadata.length, 0);
});

test('manifest is valid and every referenced script/icon exists', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const assets = [manifest.background.service_worker, ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((script) => script.js)];
  for (const asset of assets) assert.equal(fs.existsSync(path.join(root, asset)), true, asset);
  assert.ok(manifest.permissions.includes('tabs'));
});

test('protected video uses native PiP instead of removing source from page', async () => {
  const h = playerHarness({ protectedVideo: true });
  assert.equal((await h.api.perform('enter')).mode, 'native');
  assert.equal(h.main.document.pictureInPictureElement, h.source);
  assert.equal(h.streams.length, 0);
});

test('unavailable capture falls back to Chrome native PiP', async () => {
  const h = playerHarness();
  h.source.captureStream = () => undefined;
  const result = await h.api.perform('enter');
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'native');
  assert.equal(h.main.document.pictureInPictureElement, h.source);
});

test('failed Document PiP releases captured stream and opens native PiP', async () => {
  const h = playerHarness();
  h.main.documentPictureInPicture.requestWindow = async () => { throw new Error('denied'); };
  const result = await h.api.perform('enter');
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'native');
  assert.equal(h.main.document.pictureInPictureElement, h.source);
  assert.equal(h.streams[0].getTracks()[0].stopped, true);
});
