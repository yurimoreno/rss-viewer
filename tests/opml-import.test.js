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
    this.style = {};
    this.href = '';
    this.download = '';
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

  click() {}

  remove() {
    if (!this.parentElement) {
      return;
    }

    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
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
  const downloadLinks = [];
  const createdBlobs = [];
  const revokedUrls = [];

  const elements = {
    'feed-form': new FakeElement('form'),
    'feed-url': new FakeElement('input'),
    'load-feed': new FakeElement('button'),
    'opml-file': new FakeElement('input'),
    'opml-export': new FakeElement('button'),
    status: new FakeElement('section'),
    results: new FakeElement('ul'),
    'recent-feeds': new FakeElement('ul'),
    'recent-feeds-empty': new FakeElement('p'),
    'sidebar-groups': new FakeElement('nav')
  };

  const body = new FakeElement('body');

  const document = {
    createElement(tagName) {
      const element = new FakeElement(tagName);
      if (tagName.toLowerCase() === 'a') {
        element.click = () => {
          downloadLinks.push({
            href: element.href,
            download: element.download
          });
        };
      }
      return element;
    },
    createDocumentFragment() {
      return new FakeDocumentFragment();
    },
    getElementById(id) {
      return elements[id];
    },
    body
  };

  const localStorage = createLocalStorage(localStorageSeed);
  class FakeBlob {
    constructor(parts, options = {}) {
      this.parts = Array.isArray(parts) ? parts : [];
      this.type = options.type || '';
    }
  }
  URL.createObjectURL = (blob) => {
    createdBlobs.push(blob);
    return `blob:mock-${createdBlobs.length}`;
  };
  URL.revokeObjectURL = (url) => {
    revokedUrls.push(url);
  };

  const context = {
    document,
    localStorage,
    fetch: fetchImpl,
    DOMParser: FakeDOMParser,
    Blob: FakeBlob,
    URL,
    Intl,
    Date,
    setTimeout,
    clearTimeout,
    console
  };

  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'public/app.js' });

  return {
    elements,
    localStorage,
    downloads: {
      links: downloadLinks,
      blobs: createdBlobs,
      revokedUrls
    }
  };
}

async function run() {
  const storageKey = 'rssViewer.recentFeeds';
  const libraryKey = 'rssViewer.library';
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

    const { elements, localStorage, downloads } = bootstrapApp({
      localStorageSeed: seed,
      fetchImpl: async (requestUrl) => {
        let itemCount = 1;
        if (requestUrl.includes(encodeURIComponent('https://feed-a.example/rss.xml'))) {
          itemCount = 3;
        } else if (requestUrl.includes(encodeURIComponent('https://feed-b.example/rss.xml'))) {
          itemCount = 2;
        }

        return {
          ok: true,
          async json() {
            return {
              items: Array.from({ length: itemCount }, (_, index) => ({
                title: `Item ${index}`,
                link: `https://example.com/${index}`
              }))
            };
          }
        };
      }
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

    const storedLibrary = JSON.parse(localStorage.dump()[libraryKey]);
    assert.deepStrictEqual(
      storedLibrary,
      {
        feeds: [
          { url: 'https://feed-a.example/rss.xml', title: 'Feed A', category: 'Tech' },
          { url: 'https://feed-b.example/rss.xml', title: 'Feed B', category: 'Tech' },
          { url: existingUrl, title: 'Existing', category: 'Uncategorized' }
        ],
        categories: ['Tech', 'Uncategorized']
      },
      'OPML import should persist a normalized feed library with categories'
    );

    const sidebarSections = elements['sidebar-groups'].children;
    assert.strictEqual(sidebarSections.length, 2, 'Sidebar should render Tech and Uncategorized groups');
    const techSection = sidebarSections[0];
    assert.ok(techSection.children[1].children.length === 2, 'Tech category should include two feeds');

    const techHeadingCount = techSection.children[0].children[1];
    assert.ok(!Number.isNaN(Number(techHeadingCount.textContent)), 'Tech category count should be numeric');

    const feedAButton = techSection.children[1].children[0].children[0];
    const feedBButton = techSection.children[1].children[1].children[0];
    assert.ok(!Number.isNaN(Number(feedAButton.children[1].textContent)), 'Feed count should be numeric');
    assert.ok(!Number.isNaN(Number(feedBButton.children[1].textContent)), 'Feed count should be numeric');

    await elements['sidebar-groups'].dispatch('click', { target: feedAButton });
    await elements['sidebar-groups'].dispatch('click', { target: feedBButton });

    const rerenderedTechSection = elements['sidebar-groups'].children[0];
    const rerenderedFeedAButton = rerenderedTechSection.children[1].children[0].children[0];
    const rerenderedFeedBButton = rerenderedTechSection.children[1].children[1].children[0];
    assert.strictEqual(rerenderedFeedAButton.children[1].textContent, '3', 'Feed A count should update after loading');
    assert.strictEqual(rerenderedFeedBButton.children[1].textContent, '2', 'Feed B count should update after loading');
    assert.strictEqual(
      rerenderedTechSection.children[0].children[1].textContent,
      '5',
      'Category count should equal the sum of feed counts'
    );

    await elements['opml-export'].dispatch('click');

    assert.strictEqual(downloads.links.length, 1, 'OPML export should trigger one download');
    assert.ok(
      /^rss-viewer-library-\d{4}-\d{2}-\d{2}\.opml$/.test(downloads.links[0].download),
      'OPML export should use a dated filename'
    );
    assert.strictEqual(downloads.blobs.length, 1, 'OPML export should generate one blob');
    const exportedOpml = downloads.blobs[0].parts.join('');
    assert.ok(
      exportedOpml.includes('<outline text="Tech" title="Tech">'),
      'OPML export should preserve categories as folder outlines'
    );
    assert.ok(
      exportedOpml.includes('<outline text="Uncategorized" title="Uncategorized">'),
      'OPML export should include Uncategorized folder when needed'
    );
    assert.ok(
      exportedOpml.includes('xmlUrl="https://feed-a.example/rss.xml"'),
      'OPML export should include feed entries in folder outlines'
    );
    assert.ok(
      exportedOpml.includes('xmlUrl="https://feed-b.example/rss.xml"'),
      'OPML export should include feed entries in folder outlines'
    );
    assert.deepStrictEqual(
      downloads.revokedUrls,
      [downloads.links[0].href],
      'OPML export should revoke the generated object URL'
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
    assert.strictEqual(localStorage.getItem(libraryKey), null, 'Invalid OPML should not modify feed library');
  }

  {
    const seed = {};
    seed[libraryKey] = JSON.stringify({
      feeds: [
        { url: 'https://startup-a.example/rss.xml', title: 'Startup A', category: 'News' },
        { url: 'https://startup-b.example/rss.xml', title: 'Startup B', category: 'News' }
      ],
      categories: ['News']
    });

    const { elements } = bootstrapApp({
      localStorageSeed: seed,
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { items: [] };
        }
      })
    });

    const sidebarSections = elements['sidebar-groups'].children;
    assert.strictEqual(sidebarSections.length, 1, 'Stored library should render sidebar groups on startup');
    assert.strictEqual(
      sidebarSections[0].children[1].children.length,
      2,
      'Stored library feeds should populate sidebar on startup'
    );
  }

  console.log('OPML import test passed: merge, sidebar metrics, and error handling verified.');
}

run().catch((error) => {
  console.error(`OPML import test failed: ${error.stack || error.message}`);
  process.exit(1);
});
