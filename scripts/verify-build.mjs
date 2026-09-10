import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const dist = join(root, 'dist');
const manifestPath = join(dist, 'manifest.json');

if (!existsSync(manifestPath)) throw new Error('dist/manifest.json est absent');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const expected = ['https://web.whatsapp.com/*'];
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(expected)) {
  throw new Error(`Permissions permanentes inattendues: ${manifest.host_permissions}`);
}
if (!manifest.optional_host_permissions?.includes('https://*/*')) {
  throw new Error('Permissions serveur facultatives absentes');
}
if (manifest.content_scripts?.some((script) => script.world === 'MAIN')) {
  throw new Error('Le bundle MAIN aurait dû être réinjecté par le build');
}

const files = readdirSync(join(dist, 'assets')).filter((file) => file.endsWith('.js'));
const source = files.map((file) => readFileSync(join(dist, 'assets', file), 'utf8')).join('\n');
for (const required of ['TRANSCRIBE_REQUEST', '/v1/audio/transcriptions', '__wttVoice']) {
  if (!source.includes(required)) throw new Error(`Fonction compilée manquante: ${required}`);
}
for (const forbidden of ['api.elevenlabs.io', 'api.anthropic.com', 'api.openai.com']) {
  if (source.includes(forbidden)) throw new Error(`Fournisseur externe codé en dur: ${forbidden}`);
}

console.log('✓ Extension compilée, manifeste vérifié et aucun fournisseur externe codé en dur.');
