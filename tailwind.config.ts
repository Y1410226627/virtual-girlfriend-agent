import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        cream: '#FFF9F5',
        peach: {
          50: '#FFF4EF',
          100: '#FFE7DC',
          200: '#FFD3C1',
          300: '#FFB59A',
          400: '#FF8F6B',
          500: '#F97450',
          600: '#E85A38',
          700: '#C24427',
        },
        rose: {
          50: '#FFF1F4',
          100: '#FFE2E9',
          200: '#FFC9D6',
          300: '#FFA3BB',
          400: '#FF7BA0',
          500: '#F65C8A',
          600: '#E03E70',
          700: '#B92B58',
        },
        ink: {
          900: '#3B2B33',
          700: '#5B4650',
          500: '#8A707C',
          300: '#BBA5AE',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          '"Noto Sans SC"',
          'Segoe UI',
          'sans-serif',
        ],
      },
      boxShadow: {
        soft: '0 8px 30px rgba(246, 92, 138, 0.10)',
        bubble: '0 2px 12px rgba(246, 92, 138, 0.12)',
      },
      borderRadius: {
        '4xl': '2rem',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.45' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.28s ease-out',
        'pulse-soft': 'pulse-soft 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;