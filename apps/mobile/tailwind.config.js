const nativewind = require("nativewind/preset");

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  presets: [nativewind],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Outfit"],
        mono: ["Outfit"],
      },
      colors: {
        gray: {
          50: "#f9fafb",
          100: "#f2f4f7",
          200: "#e4e7ec",
          300: "#d0d5dd",
          400: "#98a2b3",
          500: "#667085",
          600: "#475467",
          700: "#344054",
          800: "#1d2939",
          900: "#101828",
          950: "#0c111d",
        },
        brand: {
          50: "#fff4f0",
          100: "#ffe7de",
          500: "#ff7e5f",
          600: "#f0613e",
          700: "#cc4528",
          800: "#a63620",
        },
        error: {
          50: "#fef3f2",
          600: "#d92d20",
          700: "#b42318",
        },
        success: {
          50: "#ecfdf3",
          700: "#067647",
        },
      },
    },
  },
  plugins: [],
};
