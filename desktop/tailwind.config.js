/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/renderer/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#fef7f0',
          100: '#fdebd9',
          200: '#fbd4b2',
          300: '#f8b580',
          400: '#f4904d',
          500: '#f07428',
          600: '#e15a1e',
          700: '#bb431a',
          800: '#95361c',
          900: '#782f1a',
        },
      },
    },
  },
  plugins: [],
}
