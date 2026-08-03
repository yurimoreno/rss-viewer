const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');

/**
 * Boots the real public/index.html + public/lib/read-state.js + public/app.js
 * in a jsdom window, so tests exercise the actual current DOM structure
 * instead of a hand-maintained fake.
 */
function bootstrapApp({ fetchImpl, localStorageSeed = {}, confirmImpl } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window;
  const document = window.document;

  Object.entries(localStorageSeed).forEach(([key, value]) => {
    window.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  });

  window.fetch = fetchImpl || (async () => ({ ok: false, status: 404, json: async () => ({}) }));
  window.alert = () => {};
  window.confirm = confirmImpl || (() => true);
  // jsdom doesn't implement layout, so scrollIntoView is missing.
  window.HTMLElement.prototype.scrollIntoView = () => {};

  const ctx = dom.getInternalVMContext();
  const readStateSrc = fs.readFileSync(path.join(ROOT, 'public', 'lib', 'read-state.js'), 'utf8');
  vm.runInContext(readStateSrc, ctx, { filename: 'public/lib/read-state.js' });
  const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  vm.runInContext(appSrc, ctx, { filename: 'public/app.js' });

  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true, cancelable: true }));

  return { window, document, localStorage: window.localStorage };
}

function fireEvent(el, type) {
  el.dispatchEvent(new el.ownerDocument.defaultView.Event(type, { bubbles: true, cancelable: true }));
}

function click(el) {
  fireEvent(el, 'click');
}

function setValue(el, value, eventType = 'input') {
  el.value = value;
  fireEvent(el, eventType);
}

/** Stubs a file input's `.files` (jsdom's FileList has no public constructor). */
function setFiles(inputEl, files) {
  Object.defineProperty(inputEl, 'files', { value: files, configurable: true });
}

function getJson(localStorage, key) {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

module.exports = { bootstrapApp, click, setValue, fireEvent, setFiles, getJson };
