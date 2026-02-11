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

  toggle(name, force) {
    if (typeof force === 'boolean') {
      if (force) {
        this.classes.add(name);
      } else {
        this.classes.delete(name);
      }
      return force;
    }

    if (this.classes.has(name)) {
      this.classes.delete(name);
      return false;
    }

    this.classes.add(name);
    return true;
  }

  contains(name) {
    return this.classes.has(name);
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

function findChildByClass(element, className) {
  if (!element) {
    return null;
  }

  if (element.className === className) {
    return element;
  }

  for (const child of element.children) {
    const match = findChildByClass(child, className);
    if (match) {
      return match;
    }
  }

  return null;
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
    'sidebar-groups': new FakeElement('nav'),
    'feed-view': new FakeElement('section'),
    'saved-view': new FakeElement('section'),
    'saved-results': new FakeElement('ul'),
    'saved-empty': new FakeElement('p'),
    'saved-view-toggle': new FakeElement('button'),
    'feed-view-toggle': new FakeElement('button')
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
  const libraryKey = 'rssViewer.library';
  const cacheKey = 'rssViewer.feedItemCache';
  const feedUrl = 'https://feed-a.example/rss.xml';
  const opml = `<?xml version="1.0"?>
    <opml version="1.0">
      <body>
        <outline text="Tech">
          <outline text="Feed A" xmlUrl="${feedUrl}" />
        </outline>
      </body>
    </opml>`;

  const items = [
    { title: 'Item A', link: 'https://example.com/a', pubDate: '2024-01-02' }
  ];

  const { elements, localStorage } = bootstrapApp({
    localStorageSeed: {},
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { items };
      }
    })
  });

  const file = { text: async () => opml };
  elements['opml-file'].files = [file];
  await elements['opml-file'].dispatch('change');

  elements['feed-url'].value = feedUrl;
  await elements['feed-form'].dispatch('submit');

  const firstItem = elements.results.children[0];
  const saveToggle = findChildByClass(firstItem, 'item-save-toggle');
  assert.ok(saveToggle, 'Save toggle should be rendered');
  await saveToggle.dispatch('click');

  const cached = JSON.parse(localStorage.dump()[cacheKey]);
  assert.strictEqual(cached[feedUrl].filter((item) => item.isSaved).length, 1, 'Save toggle should persist');

  await elements['saved-view-toggle'].dispatch('click');
  assert.strictEqual(elements['saved-results'].children.length, 1, 'Saved view should render saved items');
  assert.ok(
    elements['saved-empty'].classList.classes.has('is-hidden'),
    'Saved empty state should be hidden when items exist'
  );

  const seed = {};
  seed[libraryKey] = JSON.stringify({
    feeds: [{ url: feedUrl, title: 'Feed A', category: 'Tech' }],
    categories: ['Tech']
  });
  seed[cacheKey] = JSON.stringify(cached);

  const reloaded = bootstrapApp({
    localStorageSeed: seed,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { items: [] };
      }
    })
  });

  await reloaded.elements['saved-view-toggle'].dispatch('click');
  assert.strictEqual(
    reloaded.elements['saved-results'].children.length,
    1,
    'Saved items should persist across reloads'
  );

  console.log('Saved view test passed: toggle, list, and persistence verified.');
}

run().catch((error) => {
  console.error(`Saved view test failed: ${error.stack || error.message}`);
  process.exit(1);
});
