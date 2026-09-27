const fs = require('fs');
const path = require('path');

const requiredFiles = [
  { name: 'server.js', path: path.join(__dirname, '..', 'server.js') },
  { name: 'public/index.html', path: path.join(__dirname, '..', 'public', 'index.html') },
  { name: 'public/styles.css', path: path.join(__dirname, '..', 'public', 'styles.css') }
];

const missing = requiredFiles.filter((file) => !fs.existsSync(file.path));

if (missing.length > 0) {
  const names = missing.map((file) => file.name).join(', ');
  console.error(`Smoke test failed: missing required file(s): ${names}`);
  process.exit(1);
}

// Category collapse on All/Today is class-driven: without these rules, toggle
// flips is-collapsed but items never hide and unread summaries never appear.
const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const collapseRules = [
  '.feed-group.is-collapsed .results',
  '.feed-group.is-collapsed .feed-group-detail',
  '.feed-group.is-collapsed .feed-group-collapsed-summary'
];
const missingRules = collapseRules.filter((rule) => !styles.includes(rule));
if (missingRules.length > 0) {
  console.error(
    'Smoke test failed: feed-group collapse CSS missing (category toggles break):\n  ' +
      missingRules.join('\n  ')
  );
  process.exit(1);
}

console.log('Smoke test passed: required scaffold files exist; feed-group collapse CSS present.');
