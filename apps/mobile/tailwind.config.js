const nativewind = require("nativewind/preset");

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  presets: [nativewind],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#fff4f0",
          100: "#ffe7de",
          500: "#ff7e5f",
          600: "#f0613e",
          700: "#cc4528",
        },
        error: {
          50: "#fef3f2",
          600: "#dc2626",
          700: "#b42318",
        },
      },
    },
  },
  plugins: [],
};
