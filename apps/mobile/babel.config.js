module.exports = function (api) {
  api.cache.using(() => process.env.NODE_ENV);

  const plugins = api.env("production")
    ? [["transform-remove-console", { exclude: ["error", "warn"] }]]
    : [];

  return {
    presets: [
      [
        "babel-preset-expo",
        { jsxImportSource: "nativewind", unstable_transformImportMeta: true },
      ],
      "nativewind/babel",
    ],
    plugins,
  };
};
