const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch all files in the monorepo (specifically packages/api-client)
config.watchFolders = [
  path.resolve(workspaceRoot, 'packages/api-client'),
];

// 2. Let Metro know where to resolve packages
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
];

// 3. Map @flyleaf/api-client directly
config.resolver.extraNodeModules = {
  '@flyleaf/api-client': path.resolve(workspaceRoot, 'packages/api-client/dist'),
};

module.exports = config;
