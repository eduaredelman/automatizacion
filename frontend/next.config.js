/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  images: {
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost' },
      { protocol: 'https', hostname: '*.fiberperu.com' },
    ],
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://backend:3001/api/:path*',
      },
      {
        source: '/webhook',
        destination: 'http://backend:3001/webhook',
      },
      {
        source: '/uploads/:path*',
        destination: 'http://backend:3001/uploads/:path*',
      },
      {
        source: '/socket.io/:path*',
        destination: 'http://backend:3001/socket.io/:path*',
      },
    ];
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001',
    NEXT_PUBLIC_SOCKET_URL: process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001',
  },
};

module.exports = nextConfig;
