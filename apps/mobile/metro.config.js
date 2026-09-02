const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
const defaultResolveRequest = config.resolver.resolveRequest;
const valtioRoot = path.dirname(require.resolve('valtio/package.json'));
const valtioCjsEntries = new Map([
  ['valtio', 'index.js'],
  ['valtio/react', 'react.js'],
  ['valtio/react/utils', 'react/utils.js'],
  ['valtio/utils', 'utils.js'],
  ['valtio/vanilla', 'vanilla.js'],
  ['valtio/vanilla/utils', 'vanilla/utils.js'],
]);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolveRequest ?? context.resolveRequest;
  if (platform === 'web') {
    const cjsEntry = valtioCjsEntries.get(moduleName);
    if (cjsEntry) {
      return {
        type: 'sourceFile',
        filePath: path.join(valtioRoot, cjsEntry),
      };
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
