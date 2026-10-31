const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
require("./scripts/message-surface.cjs").generate();

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

// app.json disables tsconfigPaths because the TypeScript aliases for React and
// React Native point at declaration files. Metro resolves the workspace packages.
// Shared sources also serve the desktop app, which uses a different React Native
// version. Resolve the mobile runtime from this package for every shared import.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const mobileRuntime = /^(react|react-dom|react-native)(\/|$)/.test(moduleName);
  return context.resolveRequest(
    mobileRuntime ? { ...context, originModulePath: path.join(projectRoot, "index.ts") } : context,
    moduleName,
    platform,
  );
};

config.maxWorkers = 4;
module.exports = config;
