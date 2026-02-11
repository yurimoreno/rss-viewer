const fs = require('fs');
const path = require('path');

const requiredFiles = [
  { name: 'server.js', path: path.join(__dirname, '..', 'server.js') },
  { name: 'public/index.html', path: path.join(__dirname, '..', 'public', 'index.html') }
];

const missing = requiredFiles.filter((file) => !fs.existsSync(file.path));

if (missing.length > 0) {
  const names = missing.map((file) => file.name).join(', ');
  console.error(`Smoke test failed: missing required file(s): ${names}`);
  process.exit(1);
}

console.log('Smoke test passed: required scaffold files exist.');
