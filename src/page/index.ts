// Main-world entry point. Loaded into web.whatsapp.com as a module via the content script.

import { waitTillReady, waitForModules } from './wa';
import { installSendHook } from './hooks/send';
import { installComposerObserver } from './hooks/composer';
import { installInlineTranslation } from './hooks/inline-translate';
import { installAttachMenuItem } from './hooks/attach-menu';
import { mountUI } from './ui/mount';
import { requestSnapshot } from './store';
import { installVoiceCaptureBridge } from '@/voice/page-audio';
import { installHealthChecks } from './health';

// Each hook waits only for its own modules, so an optional module (e.g. the attach menu,
// renamed by WhatsApp) never delays the essential hooks.
const SEND_MODULES = ['WAWebSendTextMsgChatAction'];

console.info('[wa-translate] page-world script booted');

(async () => {
  // The DOM-based observers and the modal/picker UI don't need WA's modules — mount them
  // immediately so the user sees responsive UI as soon as WhatsApp's chat list renders.
  requestSnapshot();
  mountUI();
  installComposerObserver();
  installVoiceCaptureBridge();

  await waitTillReady();
  console.info('[wa-translate] WhatsApp bundle ready');

  const inline = waitForModules(['WAWebChatCollection']).then((missing) => {
    if (missing.length) console.warn('[wa-translate] incoming translation disabled, missing:', missing);
    else installInlineTranslation();
  });
  const send = waitForModules(SEND_MODULES).then((missing) => {
    if (missing.length) console.warn('[wa-translate] outgoing translation disabled, missing:', missing);
    else installSendHook();
  });
  // Optional: retries on its own while the attach-menu modules load.
  installAttachMenuItem();

  await Promise.all([inline, send]);
  installHealthChecks();
  console.info('[wa-translate] ready');
})();
