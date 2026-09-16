// Build a shareable team package: release/whatsapp-web-translator-<version>.zip containing
// the extension folder (without source maps) and an installation guide.
//
//   WTT_SERVER_URL=https://translator.example.com pnpm package
//
// The server address is baked into the build by vite.config.ts; tokens never are.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dist = join(root, 'dist');
const server = process.env.WTT_SERVER_URL || '';

if (!existsSync(join(dist, 'manifest.json'))) throw new Error('dist/ absent : lancez pnpm verify');
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (manifest.version !== version) throw new Error(`dist/ (${manifest.version}) ne correspond pas à ${version} : relancez pnpm verify`);
const devBuild = readdirSync(join(dist, 'assets'))
  .filter((file) => file.endsWith('.js'))
  .some((file) => readFileSync(join(dist, 'assets', file), 'utf8').includes('DEV_RELOAD'));
if (devBuild) throw new Error('Build de développement : le paquet d’équipe doit être compilé sans WTT_DEV');

const name = `whatsapp-web-translator-${version}`;
const staging = join(root, 'release', name);
const extensionDir = join(staging, 'whatsapp-web-translator');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(dist, extensionDir, { recursive: true, filter: (src) => !src.endsWith('.map') });

const escape = (value) => value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const template = readFileSync(join(root, 'scripts', 'INSTALLATION.html'), 'utf8');
const serverStep = server
  ? `L’adresse du serveur est déjà remplie : <code>${escape(server)}</code>.`
  : 'Dans <strong>Adresse du serveur</strong>, collez l’adresse qui vous a été communiquée.';
writeFileSync(
  join(staging, 'INSTALLATION.html'),
  template.replaceAll('{{VERSION}}', escape(version)).replaceAll('{{SERVER_STEP}}', serverStep),
);

const zipPath = join(root, 'release', `${name}.zip`);
rmSync(zipPath, { force: true });
execFileSync('zip', ['-rqX', zipPath, name, '-x', '*.DS_Store'], { cwd: join(root, 'release') });

console.log(`✓ Paquet prêt : release/${name}.zip`);
console.log(server ? `  Serveur préconfiguré : ${server}` : '  Aucun serveur préconfiguré (WTT_SERVER_URL non défini)');
