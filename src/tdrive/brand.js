/* KamsClouds brand — single source of truth for the visible app name.
 * Internal storage keys stay "tdrive.*" on purpose (existing caches keep working).
 */

export const BRAND = {
  name: "KamsClouds",
  short: "Kams",
  tagline: "Your own cloud drive with a Google Drive feel, powered by your Telegram chat.",
  // anchor prefix for deep links inside the page hash (#kamsclouds=...).
  // "#tdrive=" is still accepted for old links.
  hashPrefix: "#kamsclouds=",
  legacyHashPrefix: "#tdrive=",
  // share links keep "#share=" so old shared links keep working.
  sharePrefix: "#share=",
};
