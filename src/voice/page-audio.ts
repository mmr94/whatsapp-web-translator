const TAG = '__wttVoice';

export function installVoiceCaptureBridge(): void {
  const marker = '__wttVoiceCaptureInstalled';
  if ((window as unknown as Record<string, unknown>)[marker]) return;
  (window as unknown as Record<string, unknown>)[marker] = true;

  const retained = new Map<string, Blob>();
  const seen = new Set<HTMLMediaElement>();
  let capture: { id: number; done: boolean } | null = null;
  let suppressUntil = 0;

  const reply = (id: number, payload: Record<string, unknown>) => {
    window.postMessage({ [TAG]: 'res', id, ...payload }, '*');
  };

  const remember = (node: HTMLMediaElement) => {
    seen.add(node);
    while (seen.size > 30) seen.delete(seen.values().next().value as HTMLMediaElement);
  };

  const silenceAll = () => {
    for (const node of seen) {
      try {
        node.pause();
        node.currentTime = 0;
        node.muted = false;
        node.volume = 1;
      } catch {}
    }
  };

  const grab = async (url: string) => {
    if (!capture || capture.done || !url?.startsWith('blob:')) return;
    capture.done = true;
    const id = capture.id;
    try {
      const response = await fetch(url);
      if (!response.ok) return reply(id, { ok: false, error: `blob ${response.status}` });
      const blob = await response.blob();
      if (!blob.size) return reply(id, { ok: false, error: 'Audio vide' });
      reply(id, { ok: true, blob, mimeType: blob.type, size: blob.size });
    } catch (error) {
      reply(id, { ok: false, error: (error as Error)?.message ?? String(error) });
    }
  };

  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (object: Blob | MediaSource): string {
    const url = originalCreateObjectURL(object);
    try {
      if (object instanceof Blob && object.size <= 30 * 1024 * 1024) {
        retained.set(url, object);
        while (retained.size > 40) retained.delete(retained.keys().next().value as string);
        void grab(url);
      }
    } catch {}
    return url;
  };

  const originalPlay = HTMLMediaElement.prototype.play;
  const originalPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.play = function (): Promise<void> {
    try {
      remember(this);
      void grab(this.src || this.currentSrc);
    } catch {}
    if (Date.now() < suppressUntil) {
      try {
        this.muted = true;
        this.volume = 0;
        originalPause.call(this);
      } catch {}
      return Promise.resolve();
    }
    return originalPlay.apply(this);
  };

  try {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (descriptor?.get && descriptor.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          return descriptor.get!.call(this);
        },
        set(value: string) {
          try {
            remember(this);
            void grab(value);
          } catch {}
          descriptor.set!.call(this, value);
        },
      });
    }
  } catch {}

  try {
    const OriginalAudio = window.Audio;
    const PatchedAudio = function (this: unknown, src?: string) {
      const audio = new OriginalAudio(src);
      remember(audio);
      if (src) void grab(src);
      return audio;
    } as unknown as typeof Audio;
    PatchedAudio.prototype = OriginalAudio.prototype;
    window.Audio = PatchedAudio;
  } catch {}

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.[TAG] !== 'req') return;
    const { id, action, url, ms } = event.data as {
      id: number;
      action: string;
      url?: string;
      ms?: number;
    };
    try {
      if (action === 'ping') reply(id, { ok: true });
      else if (action === 'arm') {
        suppressUntil = Date.now() + (ms || 35_000);
        capture = { id, done: false };
      } else if (action === 'hold') {
        suppressUntil = Date.now() + (ms || 2_500);
        reply(id, { ok: true });
      } else if (action === 'silence') {
        silenceAll();
        reply(id, { ok: true });
      } else if (action === 'disarm') {
        suppressUntil = 0;
        capture = null;
        silenceAll();
        reply(id, { ok: true });
      } else if (action === 'reopen' && url) {
        const blob = retained.get(url);
        reply(id, blob ? { ok: true, blob } : { ok: false, error: 'Audio expiré' });
      }
    } catch (error) {
      reply(id, { ok: false, error: (error as Error)?.message ?? String(error) });
    }
  });
}
