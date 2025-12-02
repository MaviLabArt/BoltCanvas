/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html","./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      borderRadius: {
        "3xl": "1.5rem",
      },
    },
  },
  plugins: [],
};
