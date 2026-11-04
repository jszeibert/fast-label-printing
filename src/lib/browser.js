// Cross-browser WebExtension API (Firefox exposes `browser`, Chrome `chrome`).
export const browserAPI = globalThis.browser ?? globalThis.chrome;
