'use strict';
// Applies the window icon + version info to a Windows executable using rcedit.

const path = require('path');
const { execFileSync } = require('child_process');
const rcedit = require('rcedit').rcedit;

const here = __dirname;
const exe = process.argv[2] || path.join(here, '..', '..', 'release', 'exe', 'LANAudio.exe');
const ico = path.join(here, 'appicon.ico');

(async () => {
  await rcedit(exe, {
    icon: ico,
    'file-version': '1.0.0.0',
    'product-version': '1.0.0.0',
    'version-string': {
      CompanyName: 'LAN Audio',
      FileDescription: 'LAN Audio - 局域网声音互传',
      ProductName: 'LAN Audio',
      LegalCopyright: '',
      OriginalFilename: 'LANAudio.exe',
      InternalName: 'LANAudio',
    },
  });
  console.log('icon + version info applied to', exe);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
