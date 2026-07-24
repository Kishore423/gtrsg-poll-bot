const { execFileSync } = require('node:child_process');
const { readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

const roots = ['api', 'public', 'scripts', 'src', 'test'];
function files(path) {
  return readdirSync(path).flatMap((name) => {
    const full = join(path, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.js') ? [full] : [];
  });
}
for (const file of roots.flatMap(files)) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log('JavaScript syntax check passed.');
