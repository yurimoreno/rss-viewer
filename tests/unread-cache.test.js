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
    'item-search': new FakeElement('input'),
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
  const secondFeedUrl = 'https://feed-b.example/rss.xml';
  const opml = `<?xml version="1.0"?>
    <opml version="1.0">
      <body>
        <outline text="Tech">
          <outline text="Feed A" xmlUrl="${feedUrl}" />
          <outline text="Feed B" xmlUrl="${secondFeedUrl}" />
        </outline>
      </body>
    </opml>`;

  const items = new Array(60).fill(null).map((_, index) => ({
    title: `Item ${index}`,
    link: `https://example.com/${index}`,
    pubDate: `2024-01-${String((index % 30) + 1).padStart(2, '0')}`
  }));

  const secondFeedItems = [
    {
      title: 'Searchable Match',
      link: 'https://example.com/match',
      pubDate: '2024-02-01',
      summary: 'This summary includes alpha keyphrase.'
    },
    {
      title: 'Unrelated',
      link: 'https://example.com/unrelated',
      pubDate: '2024-02-02',
      summary: 'No matching keywords here.'
    }
  ];

  const { elements, localStorage } = bootstrapApp({
    localStorageSeed: {},
    fetchImpl: async (requestUrl) => {
      const parsed = new URL(`http://localhost${requestUrl}`);
      const target = parsed.searchParams.get('url');

      return {
        ok: true,
        async json() {
          return { items: target === secondFeedUrl ? secondFeedItems : items };
        }
      };
    }
  });

  const file = { text: async () => opml };
  elements['opml-file'].files = [file];
  await elements['opml-file'].dispatch('change');

  const library = JSON.parse(localStorage.dump()[libraryKey]);
  assert.strictEqual(library.feeds.length, 2, 'Library should store imported feeds');

  elements['feed-url'].value = feedUrl;
  await elements['feed-form'].dispatch('submit');

  const cached = JSON.parse(localStorage.dump()[cacheKey]);
  assert.strictEqual(cached[feedUrl].length, 50, 'Cached feed items should be capped at 50');

  const sidebarFeed = elements['sidebar-groups'].children[0].children[1].children[0].children[0];
  assert.strictEqual(sidebarFeed.children[1].textContent, '50', 'Unread count should equal cached items');

  const firstItem = elements.results.children[0];
  const readToggle = findChildByClass(firstItem, 'item-read-toggle');
  assert.ok(readToggle, 'Read toggle should be rendered');
  await readToggle.dispatch('click');

  const updatedCache = JSON.parse(localStorage.dump()[cacheKey]);
  const readItems = updatedCache[feedUrl].filter((item) => item.isRead);
  assert.strictEqual(readItems.length, 1, 'Read toggle should mark one item as read');

  const updatedSidebarFeed = elements['sidebar-groups'].children[0].children[1].children[0].children[0];
  assert.strictEqual(updatedSidebarFeed.children[1].textContent, '49', 'Unread count should update after read');

  elements['feed-url'].value = secondFeedUrl;
  await elements['feed-form'].dispatch('submit');

  assert.strictEqual(
    elements.results.children.length,
    2,
    'Selecting second feed should render second feed items before searching'
  );

  const searchInput = elements['item-search'];
  searchInput.value = 'searchable';
  await searchInput.dispatch('input');

  assert.strictEqual(
    elements.results.children.length,
    1,
    'Search should filter cached items across all feeds by title/summary'
  );
  assert.strictEqual(
    elements.results.children[0].children[0].children[0].textContent,
    'Searchable Match',
    'Search result should render in the feed list pane'
  );

  searchInput.value = '';
  await searchInput.dispatch('input');

  assert.strictEqual(
    elements.results.children.length,
    2,
    'Clearing search should restore the selected feed list'
  );

  console.log('Unread cache test passed: cap, read state, counts, and search behavior verified.');
}

run().catch((error) => {
  console.error(`Unread cache test failed: ${error.stack || error.message}`);
  process.exit(1);
});
