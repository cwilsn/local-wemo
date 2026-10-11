import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('home menu links to both HTTPS apps and all its assets stay inside its static directory', async () => {
  const directory = new URL('../public/home/', import.meta.url);
  const html = await readFile(new URL('index.html', directory), 'utf8');
  const links = [...html.matchAll(/<a[^>]*href="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(links, ['/', '/pool/', '/lights/']);
  assert.match(html, /aria-label="Home apps"/);
  assert.doesNotMatch(html, /<script/);
  for (const match of html.matchAll(/(?:href|src)="([^"]+\.(?:css|svg))"/g)) {
    const asset = new URL(match[1], directory);
    assert.ok(asset.href.startsWith(directory.href));
    assert.ok((await readFile(asset)).length > 0);
  }
});

test('light assets resolve within either the LAN root or the HTTPS lights path', async () => {
  const directory = new URL('../public/', import.meta.url);
  const html = await readFile(new URL('index.html', directory), 'utf8');
  for (const path of ['/', '/lights/']) {
    const page = new URL(path, 'https://pipipi.tailde190.ts.net');
    for (const match of html.matchAll(/(?:href|src)="([^"]+\.(?:css|js|svg))"/g)) {
      assert.equal(new URL(match[1], page).pathname, path + match[1]);
      assert.ok((await readFile(new URL(match[1], directory))).length > 0);
    }
  }
  assert.match(html, /href="\/" aria-label="Back to home menu"/);
});
