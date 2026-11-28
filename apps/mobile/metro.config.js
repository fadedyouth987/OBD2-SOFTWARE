// Metro in a pnpm monorepo: watch the shared packages and resolve from both the app
// and the workspace root. (Expo's default config handles pnpm's symlinks.)
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);
config.watchFolders = [path.join(workspaceRoot, "packages")];
config.resolver.nodeModulesPaths = [path.join(projectRoot, "node_modules"), path.join(workspaceRoot, "node_modules")];
module.exports = config;
