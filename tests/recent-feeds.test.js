const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class ClassList {
  constructor() {
    this.classes = new Set();
  }

  add(...names) {
    names.forEach((name) => this.classes.add(name));
  }

  remove(...names) {
    names.forEach((name) => this.classes.delete(name));
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.className = '';
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.classList = new ClassList();
  }

  append(...nodes) {
    nodes.forEach((node) => this.appendChild(node));
  }

  appendChild(node) {
    if (node && node.isFragment) {
      node.children.forEach((child) => this.appendChild(child));
      return node;
    }

    node.parentElement = this;
    this.children.push(node);
    return node;
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }

  async dispatch(type, event = {}) {
    const handler = this.listeners[type];
    if (!handler) {
      return;
    }

    const enriched = {
      preventDefault() {},
      target: this,
      ...event
    };

    return handler(enriched);
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  closest(selector) {
    if (selector === 'button[data-url]' && this.tagName === 'BUTTON' && typeof this.dataset.url === 'string') {
      return this;
    }

    return this.parentElement ? this.parentElement.closest(selector) : null;
  }

  set innerHTML(_) {
    this.children = [];
    this.textContent = '';
  }
}

class FakeDocumentFragment {
  constructor() {
    this.isFragment = true;
    this.children = [];
  }

  appendChild(node) {
    this.children.push(node);
  }
}

function createLocalStorage(seed = {}) {
  const state = { ...seed };
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(state, key) ? state[key] : null;
    },
    setItem(key, value) {
      state[key] = String(value);
    },
    dump() {
      return { ...state };
    }
  };
}

function bootstrapApp({ fetchImpl, localStorageSeed = {} }) {
  const elements = {
    'feed-form': new FakeElement('form'),
    'feed-url': new FakeElement('input'),
    'load-feed': new FakeElement('button'),
    status: new FakeElement('section'),
    results: new FakeElement('ul'),
    'recent-feeds': new FakeElement('ul'),
    'recent-feeds-empty': new FakeElement('p')
  };

  const document = {
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    createDocumentFragment() {
      return new FakeDocumentFragment();
    },
    getElementById(id) {
      return elements[id];
    }
  };

  const localStorage = createLocalStorage(localStorageSeed);

  const context = {
    document,
    localStorage,
    fetch: fetchImpl,
    URL,
    Intl,
    Date,
    setTimeout,
    clearTimeout,
    console
  };

  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'public/app.js' });

  return { elements, localStorage };
}

async function run() {
  const storageKey = 'rssViewer.recentFeeds';
  const savedUrl = 'https://example.com/feed.xml';

  {
    const { elements, localStorage } = bootstrapApp({
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { items: [] };
        }
      })
    });

    elements['feed-url'].value = savedUrl;
    await elements['feed-form'].dispatch('submit');

    const stored = JSON.parse(localStorage.dump()[storageKey]);
    assert.deepStrictEqual(stored, [savedUrl], 'successful load should persist URL');
  }

  {
    const seed = {};
    seed[storageKey] = JSON.stringify([savedUrl]);

    const calls = [];
    const { elements } = bootstrapApp({
      localStorageSeed: seed,
      fetchImpl: async (url) => {
        calls.push(url);
        return {
          ok: true,
          async json() {
            return { items: [] };
          }
        };
      }
    });

    assert.strictEqual(elements['recent-feeds'].children.length, 1, 'recent URL should render from storage');
    const recentButton = elements['recent-feeds'].children[0].children[0];
    await elements['recent-feeds'].dispatch('click', { target: recentButton });
    assert.strictEqual(calls.length, 1, 'clicking recent feed should trigger reload');
    assert.ok(calls[0].includes(encodeURIComponent(savedUrl)), 'reload should use stored URL');
  }

  {
    const { elements, localStorage } = bootstrapApp({
      fetchImpl: async () => ({
        ok: false,
        async json() {
          return { error: 'fetch_failed' };
        }
      })
    });

    elements['feed-url'].value = 'https://bad.example/feed.xml';
    await elements['feed-form'].dispatch('submit');
    assert.strictEqual(localStorage.getItem(storageKey), null, 'failed loads must not persist URL');

    elements['feed-url'].value = 'not-a-url';
    await elements['feed-form'].dispatch('submit');
    assert.strictEqual(localStorage.getItem(storageKey), null, 'invalid URLs must not persist');
  }

  console.log('Recent feeds test passed: persistence, reload, and failure guards work.');
}

run().catch((error) => {
  console.error(`Recent feeds test failed: ${error.stack || error.message}`);
  process.exit(1);
});
