/**
 * The OBD driver, send guard and plan rules are plain TypeScript, so they run on
 * Node with Babel only. (The jest-expo preset installs React Native globals these
 * tests don't need.)
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  transform: { "^.+\\.[jt]sx?$": "babel-jest" },
  transformIgnorePatterns: ["/node_modules/(?!(\\.pnpm|@obd2)/)"],
};
