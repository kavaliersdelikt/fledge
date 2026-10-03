import type { NextConfig } from 'next';

// Security headers for every page. Next.js hydrates with inline scripts, so script-src allows
// 'unsafe-inline'; the only remote script origins are the two bot-protection providers the sign-up page can
// use (Cloudflare Turnstile, hCaptcha), and only the sign-up form loads them. Everything else stays on this origin.
// Images may come from any https host because plugin and add-on icons are served by their catalogs.
const dev = process.env.NODE_ENV !== 'production';
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://js.hcaptcha.com https://*.hcaptcha.com${dev ? " 'unsafe-eval'" : ''}`,
  "frame-src https://challenges.cloudflare.com https://*.hcaptcha.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // The API is on another port or host in most deployments, including its WebSocket endpoints.
  "connect-src 'self' http: https: ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The theme engine in ../shared is also used by the API, so it lives outside this folder.
  experimental: { externalDir: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self), publickey-credentials-create=(self)' },
        ],
      },
    ];
  },
};
export default nextConfig;
