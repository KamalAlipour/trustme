module.exports = {
  presets: ['babel-preset-expo'],
  // Expo Router is workspace-local, so load its plugin explicitly.
  plugins: [require('babel-preset-expo/build/expo-router-plugin').expoRouterBabelPlugin],
};
