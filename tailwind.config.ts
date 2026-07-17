import type { Config } from "tailwindcss";

// Minimal, restrained palette: neutral zinc + a single accent.
export default {
  content: ["./web/index.html", "./web/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        accent: "#3b82f6",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
