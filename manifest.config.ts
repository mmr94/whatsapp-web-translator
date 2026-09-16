import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

export default defineManifest({
  manifest_version: 3,
  name: 'WhatsApp Web Translator — Private A40',
  version: pkg.version,
  description: 'Traduction bidirectionnelle et transcription des vocaux via votre serveur privé.',
  icons: {
    16: 'public/icons/16.png',
    32: 'public/icons/32.png',
    48: 'public/icons/48.png',
    128: 'public/icons/128.png',
  },
  permissions: ['storage'],
  host_permissions: [
    'https://web.whatsapp.com/*',
  ],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'WhatsApp Web Translator',
  },
  options_ui: {
    page: 'src/options/index.html',
    open_in_tab: true,
  },
  content_scripts: [
    {
      matches: ['https://web.whatsapp.com/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_end',
    },
    {
      matches: ['https://web.whatsapp.com/*'],
      js: ['src/page/index.ts'],
      run_at: 'document_end',
      world: 'MAIN',
    },
  ],
  web_accessible_resources: [
    {
      resources: ['assets/*'],
      matches: ['https://web.whatsapp.com/*'],
    },
  ],
});
