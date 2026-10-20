export const TDriveConfig = {
  // --- Shared backend (one bot for ALL users) ------------------------------
  // PASTE YOUR BOT CREDENTIALS BELOW. Every visitor uses these, so the
  // "Connect your drive" screen is gone and the app opens straight to login.
  // NOTE: anything written here is public source — anyone viewing the
  // generator source can read it. Use a dedicated bot + private chat.
  apiBase: "https://api.telegram.org",
  apiId: 37514584,
  apiHash: "5928f13245bc0ae340f5d734b81021f1",
  botToken: "8785934442:AAGS_ttizELQroRv-Qt0rTGzoPJQQQXyZOw",
  chatId: "-1003813305636",

  indexPrefix: "PERCHANCE_DRIVE_INDEX",
  indexKind: "perchance-drive-index",
  driveKind: "perchance-drive",

  chunkSize: 8 * 1024 * 1024,
  targetChunks: 8,
  uploadConcurrency: 4,
  downloadConcurrency: 10,
  maxFileSize: 2 * 1024 * 1024 * 1024,
  maxAccounts: 24,

  pbkdf2Iterations: 120000,
  saltBytes: 16,
  sessionDays: 3650,

  minChunkSize: 4 * 1024 * 1024,
  maxChunkSize: 8 * 1024 * 1024,
  pathPrefetch: 8,
  maxUploadConcurrency: 8,
  maxDownloadConcurrency: 16,

  chunkRetries: 4,
  persistUploadMax: 192 * 1024 * 1024,
  maxVersions: 20,
  maxLogEntries: 400,
  defaultTrashDays: 30,

  shareTokenBytes: 16,
  maxShareDays: 365,
  maxSpeedMBps: 0,

  // --- GitHub Pages / static-host mode -------------------------------------
  // api.telegram.org sends no CORS headers, so a plain static host cannot call
  // it directly. Deploy the 20-line Cloudflare Worker in docs/DEPLOY-GITHUB.md
  // and paste its URL here, e.g. "https://tg-relay.you.workers.dev".
  // Empty = try direct fetch (works on Perchance via superFetch, or with a
  // self-hosted Bot API server that has CORS enabled).
  corsProxy: "",

  // --- KamsClouds selling / licensing --------------------------------------
  // Shown on the Activate screen. Put your real GCash details here before
  // deploying to GitHub. Amounts are in PHP.
  gcash: {
    number: "09972837746",
    name: "KAMS CLOUDS",
    monthlyPrice: 99,
    lifetimePrice: 1499,
  },
  plans: {
    // trial = what an unlicensed account may do (keeps app usable, nudges to pay)
    trialMaxAccounts: 1,
    trialMaxBytes: 100 * 1024 * 1024,
    monthlyDays: 30,
  },

  // --- Admin app (owner only) ------------------------------------------------
  // Password gate for support-admin.html. Set a strong password in YOUR private
  // copy before deploying. The admin file should NOT be uploaded to the public
  // site — keep it local or on a private URL. (UI gate only: real security is
  // keeping the bot token + chat private.)
  adminPass: "kams-admin-123",

  // --- Customer-service chat -------------------------------------------------
  support: {
    enabled: true,
    pollMs: 15000,
    maxMsgs: 500,
    maxText: 2000,
  },

  // --- License store caps ----------------------------------------------------
  maxLicenses: 2000,
  maxActivations: 500,
};

export const STORAGE_KEYS = {
  session: "tdrive.session.v1",
  drivePrefix: "tdrive.drive.",
  indexCache: "tdrive.index.cache.v1",
  settings: "tdrive.settings.v1",
  downloadPrefix: "tdrive.dl.",
  resume: "tdrive.resume.v1",
  encKey: "tdrive.enckey.",
  shareUnlock: "tdrive.sharekey.",
  credentials: "tdrive.credentials.v1",
  pending: "tdrive.pending.v1",
  tombstones: "tdrive.tombstones.v1",
  // NOTE: keys stay "tdrive.*" even though the app is now KamsClouds,
  // so existing users keep their cache after the rename.
  licenseCache: "tdrive.license.v1",
  supportRead: "tdrive.support.read.v1",
};
