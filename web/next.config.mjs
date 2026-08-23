/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server under .next/standalone, so the runtime image
  // carries no node_modules and the portal starts with `node server.js`.
  output: 'standalone',
  // The demo runs offline at the venue. No remote fonts, no CDN, no telemetry.
  env: { VERITY_API: process.env.VERITY_API ?? 'http://localhost:4000' },
};
export default nextConfig;
