import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#080C12',
          secondary: '#0D1420',
          tertiary: '#111927',
        },
        surface: {
          DEFAULT: '#141E2E',
          raised: '#1A2640',
        },
        border: {
          DEFAULT: 'rgba(255,255,255,0.07)',
          strong: 'rgba(255,255,255,0.12)',
        },
        accent: {
          DEFAULT: '#00C896',
          hover: '#00dba6',
          dim: 'rgba(0,200,150,0.12)',
        },
        ink: {
          DEFAULT: '#F0F4FF',
          muted: '#8A9AB8',
          faint: '#5A6880',
        },
      },
      fontFamily: {
        display: ['var(--font-syne)', 'sans-serif'],
        body: ['var(--font-dm-sans)', 'sans-serif'],
      },
      borderRadius: {
        card: '14px',
        xl2: '20px',
      },
    },
  },
  plugins: [],
}

export default config
