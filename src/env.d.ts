// Build-time flag: true only for `WTT_DEV=1 pnpm build`. Enables reloading the unpacked
// extension from the WhatsApp tab while iterating; stripped from normal builds.
declare const __DEV_RELOAD__: boolean;

// Server address preselected in the settings (`WTT_SERVER_URL` at build time).
declare const __DEFAULT_SERVER_URL__: string;
