/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { serverActions: { bodySizeLimit: "1mb" }, instrumentationHook: true },
};
export default nextConfig;
