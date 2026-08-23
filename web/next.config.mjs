/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The demo runs offline at the venue. No remote fonts, no CDN, no telemetry.
  env: { VERITY_API: process.env.VERITY_API ?? 'http://localhost:4000' },
};
export default nextConfig;
