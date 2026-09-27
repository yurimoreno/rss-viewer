// Regression: a feed <link> with `"` in the host must not break out of href="...".
const assert = require('assert');
const { sanitizeUrl } = require('../lib/sanitize');

const payload = 'http://x"onmouseover="alert(1)"x=".example.com/';
assert.strictEqual(sanitizeUrl(payload), null, 'server drops links whose host contains quotes');
assert.strictEqual(sanitizeUrl('https://example.com/a?b=1&c="2"'), 'https://example.com/a?b=1&c=%222%22');
console.log('Href escape test passed: quote-bearing feed links are rejected server-side.');
