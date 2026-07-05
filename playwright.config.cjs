const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${process.env.PORT || process.env.PLAYWRIGHT_PORT || 4173}`;

module.exports = {
  testDir: "./tests",
  timeout: 30000,
  use: {
    baseURL,
    permissions: ["notifications", "clipboard-read", "clipboard-write"],
  },
};
