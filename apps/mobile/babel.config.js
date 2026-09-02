module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Reanimated 4 needs the worklets plugin, and it must be LAST.
    plugins: ['react-native-worklets/plugin'],
  };
};
