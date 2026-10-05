/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // lint 独立运行（npm run lint），避免 Next build 与 flat config 集成互相干扰
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;