'use strict';
// Flips the PE subsystem of a Windows exe between console (3) and GUI (2).
// Node's bundled node.exe is a console app; for the packaged build we want no
// console window at all, so the launcher becomes a GUI subsystem binary.

const fs = require('fs');

const file = process.argv[2];
const want = (process.argv[3] || 'gui').toLowerCase();
const subsystem = want === 'console' ? 3 : 2;

const buf = fs.readFileSync(file);
const peOffset = buf.readUInt32LE(0x3c);
if (buf.readUInt32LE(peOffset) !== 0x00004550) {
  throw new Error('not a PE file');
}
const optionalHeader = peOffset + 24;
const magic = buf.readUInt16LE(optionalHeader);
const subsystemOffset = optionalHeader + (magic === 0x20b ? 0x5c : 0x44);
const before = buf.readUInt16LE(subsystemOffset);
buf.writeUInt16LE(subsystem, subsystemOffset);
fs.writeFileSync(file, buf);
console.log(`subsystem ${before} -> ${subsystem} (${want})`);
