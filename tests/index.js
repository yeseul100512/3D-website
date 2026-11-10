// `node --test tests/` on Node 22+ no longer scans a directory: it loads this file,
// which pulls in every *.test.mjs next to it and site.mjs (checks over the built pages). (`node --test` with no argument also works.)
const fs = require('node:fs');
for (const f of fs.readdirSync(__dirname).sort()) if (f.endsWith('.test.mjs') || f === 'site.mjs') import('./' + f);
