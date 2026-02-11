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
    this.files = null;
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

class FakeDOMParser {
  parseFromString(text) {
    const isValid = /<opml[\s>]/i.test(text);
    const urls = [];
    const regex = /xmlUrl\s*=\s*["']([^"']+)["']/gi;
    let match = regex.exec(text);
    while (match) {
      urls.push(match[1]);
      match = regex.exec(text);
    }

    return {
      querySelector(selector) {
        if (selector === 'parsererror') {
          return isValid ? null : {};
        }
        return null;
      },
      querySelectorAll(selector) {
        if (selector !== 'outline[xmlUrl]') {
          return [];
        }
        return urls.map((url) => ({
          getAttribute(name) {
            return name === 'xmlUrl' ? url : null;
          }
        }));
      }
    };
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
    'opml-file': new FakeElement('input'),
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
    DOMParser: FakeDOMParser,
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
  const existingUrl = 'https://existing.example/feed.xml';
  const opml = `<?xml version="1.0"?>
    <opml version="1.0">
      <body>
        <outline text="Feed A" xmlUrl="https://feed-a.example/rss.xml" />
        <outline text="Feed B" xmlUrl="https://feed-b.example/rss.xml" />
        <outline text="Existing" xmlUrl="${existingUrl}" />
      </body>
    </opml>`;

  {
    const seed = {};
    seed[storageKey] = JSON.stringify([existingUrl]);

    const { elements, localStorage } = bootstrapApp({
      localStorageSeed: seed,
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { items: [] };
        }
      })
    });

    const file = { text: async () => opml };
    elements['opml-file'].files = [file];
    await elements['opml-file'].dispatch('change');

    const stored = JSON.parse(localStorage.dump()[storageKey]);
    assert.deepStrictEqual(
      stored,
      ['https://feed-a.example/rss.xml', 'https://feed-b.example/rss.xml', existingUrl],
      'OPML import should merge, dedupe, and keep most-recent-first'
    );
  }

  {
    const seed = {};
    seed[storageKey] = JSON.stringify([existingUrl]);

    const { elements, localStorage } = bootstrapApp({
      localStorageSeed: seed,
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { items: [] };
        }
      })
    });

    const file = { text: async () => 'not-opml' };
    elements['opml-file'].files = [file];
    await elements['opml-file'].dispatch('change');

    assert.deepStrictEqual(
      JSON.parse(localStorage.dump()[storageKey]),
      [existingUrl],
      'Invalid OPML should not modify recent feeds'
    );
  }

  console.log('OPML import test passed: merge and error handling verified.');
}

run().catch((error) => {
  console.error(`OPML import test failed: ${error.stack || error.message}`);
  process.exit(1);
});
