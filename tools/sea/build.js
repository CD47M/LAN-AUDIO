'use strict';
// Builds release/exe/LANAudio.exe from this repository using Node SEA.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const here = __dirname;
const repo = path.resolve(here, '..', '..');
const serverDir = path.join(repo, 'server');
const webDir = path.join(repo, 'web');
const outDir = path.join(here, 'out');
const releaseExe = path.join(repo, 'release', 'exe');
const nodeExe = path.join(repo, 'release', 'node', 'node.exe');

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

function collectAssets() {
  const assets = {};
  const mimeOf = (ext) => ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  }[ext] || 'application/octet-stream');

  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else {
        const buf = fs.readFileSync(full);
        assets['/' + rel] = {
          mime: mimeOf(path.extname(full).toLowerCase()),
          data: buf.toString('base64'),
        };
      }
    }
  };
  walk(webDir, '');
  return assets;
}

async function main() {
  rmrf(outDir);
  fs.mkdirSync(outDir, { recursive: true });

  if (!fs.existsSync(nodeExe)) {
    throw new Error('missing ' + nodeExe + ' (the portable runtime)');
  }

  // 1) Bundle server + ws into a single CommonJS file.
  const bundlePath = path.join(outDir, 'server.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(serverDir, 'index.js')],
    bundle: true,
    outfile: bundlePath,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['fsevents'],
    minify: false,
  });
  console.log('bundled server');

  // 2) Wrap so that being run as a SEA main script also starts it.
  const bundled = fs.readFileSync(bundlePath, 'utf8');
  fs.writeFileSync(bundlePath, bundled + '\n');

  // 3) Assets.
  const assets = collectAssets();
  fs.writeFileSync(
    path.join(outDir, 'web-assets.json'),
    JSON.stringify(assets)
  );
  console.log('embedded assets:', Object.keys(assets).length);

  // 4) SEA config.
  const seaConfig = {
    main: 'server.bundle.js',
    output: 'lanaudio-sea-blob.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: { 'web-assets': 'web-assets.json' },
  };
  fs.writeFileSync(path.join(outDir, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));

  // 5) Generate the blob with the same Node version that will host it.
  execFileSync(nodeExe, ['--experimental-sea-config', 'sea-config.json'], {
    cwd: outDir,
    stdio: 'inherit',
  });
  console.log('generated SEA blob');

  // 6) Copy node.exe and inject.
  const exeOut = path.join(outDir, 'LANAudio.exe');
  fs.copyFileSync(nodeExe, exeOut);
  // Stamp the icon/version on the base runtime BEFORE the blob is injected:
  // postject rewrites sections and would drop resources added afterwards.
  const iconSrc = path.join(here, 'appicon.ico');
  if (fs.existsSync(iconSrc)) {
    const rceditBin = path.join(here, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
    execFileSync(rceditBin, [
      exeOut,
      '--set-icon', iconSrc,
      '--set-file-version', '1.0.0.0',
      '--set-product-version', '1.0.0.0',
      '--set-version-string', 'ProductName', 'LAN Audio',
      '--set-version-string', 'FileDescription', 'LAN Audio - LAN audio link',
      '--set-version-string', 'OriginalFilename', 'LANAudio.exe',
    ], { stdio: 'inherit' });
    console.log('icon applied to base runtime');
  }

  const postject = path.join(here, 'node_modules', 'postject', 'dist', 'cli.js');
  execFileSync(process.execPath, [
    postject,
    exeOut,
    'NODE_SEA_BLOB',
    path.join(outDir, 'lanaudio-sea-blob.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ], { cwd: here, stdio: 'inherit' });
  console.log('injected blob');

  // 7) NOTE: the exe intentionally keeps the console subsystem. Node on
  // Windows refuses to run when the PE subsystem is patched to GUI
  // (exits with 0xC0000142), so hiding the window is done by the VBS launcher.

  // 7) Publish.
  fs.mkdirSync(releaseExe, { recursive: true });
  const finalExe = path.join(releaseExe, 'lan-audio-backend-2026.exe');
  fs.copyFileSync(exeOut, finalExe);

  // 8) Ship icon (for the tray) and the tray helper next to the exe.
  if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, path.join(releaseExe, 'lanaudio.ico'));
  }
  const traySrc = path.join(here, 'lanaudio-tray.ps1');
  if (fs.existsSync(traySrc)) {
    fs.copyFileSync(traySrc, path.join(releaseExe, 'lanaudio-tray.ps1'));
  }
  const vbsSrc = path.join(here, 'LANAudio.vbs');
  if (fs.existsSync(vbsSrc)) {
    fs.copyFileSync(vbsSrc, path.join(releaseExe, '启动 LAN Audio.vbs'));
  }

  const size = fs.statSync(finalExe).size;
  console.log('wrote', finalExe, (size / 1024 / 1024).toFixed(1) + ' MB');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
