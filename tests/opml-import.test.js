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
    const rootOutlines = [];
    const stack = [];
    const tagRegex = /<\/?outline\b[^>]*>/gi;
    let match = tagRegex.exec(text);

    while (match) {
      const tag = match[0];
      const isClosing = tag.startsWith('</');
      const isSelfClosing = tag.endsWith('/>');

      if (isClosing) {
        stack.pop();
      } else {
        const attributes = {};
        const attrRegex = /(\w+)\s*=\s*["']([^"']+)["']/g;
        let attrMatch = attrRegex.exec(tag);
        while (attrMatch) {
          attributes[attrMatch[1]] = attrMatch[2];
          attrMatch = attrRegex.exec(tag);
        }

        const node = {
          tagName: 'outline',
          children: [],
          getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(attributes, name)
              ? attributes[name]
              : null;
          }
        };

        if (stack.length > 0) {
          stack[stack.length - 1].children.push(node);
        } else {
          rootOutlines.push(node);
        }

        if (!isSelfClosing) {
          stack.push(node);
        }
      }

      match = tagRegex.exec(text);
    }

    return {
      querySelector(selector) {
        if (selector === 'parsererror') {
          return isValid ? null : {};
        }
        if (selector === 'body') {
          return { children: rootOutlines };
        }
        return null;
      },
      querySelectorAll() {
        return [];
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
    'recent-feeds-empty': new FakeElement('p'),
    'sidebar-groups': new FakeElement('nav')
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
        <outline text="Tech">
          <outline text="Feed A" xmlUrl="https://feed-a.example/rss.xml" />
          <outline text="Feed B" xmlUrl="https://feed-b.example/rss.xml" />
        </outline>
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

    const sidebarSections = elements['sidebar-groups'].children;
    assert.strictEqual(sidebarSections.length, 2, 'Sidebar should render Tech and Uncategorized groups');
    const techSection = sidebarSections[0];
    assert.ok(techSection.children[1].children.length === 2, 'Tech category should include two feeds');
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
