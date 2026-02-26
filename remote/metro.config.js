const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(__dirname, "..");

const config = getDefaultConfig(projectRoot);

// Watch the shared package source directory and workspace root
config.watchFolders = [
  path.resolve(workspaceRoot, "shared"),
  workspaceRoot,
];

// Let Metro know about the workspace root for module resolution
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

module.exports = config;
