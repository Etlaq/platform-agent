import type { NextConfig } from "next";

const nextConfig: NextConfig = {

  // Allow external images from common stock photo and CDN sources
  images: {
    remotePatterns: [
      // Pexels
      { protocol: 'https', hostname: 'images.pexels.com' },
      // Unsplash
      { protocol: 'https', hostname: 'images.unsplash.com' },
      { protocol: 'https', hostname: 'plus.unsplash.com' },
      // Pixabay
      { protocol: 'https', hostname: 'pixabay.com' },
      { protocol: 'https', hostname: 'cdn.pixabay.com' },
      // UI Avatars (for generated avatars)
      { protocol: 'https', hostname: 'ui-avatars.com' },
      // Cloudinary (common CDN)
      { protocol: 'https', hostname: 'res.cloudinary.com' },
      // Imgur
      { protocol: 'https', hostname: 'i.imgur.com' },
      // Placeholder services
      { protocol: 'https', hostname: 'picsum.photos' },
      { protocol: 'https', hostname: 'placehold.co' },
      // Gravatar
      { protocol: 'https', hostname: 'www.gravatar.com' },
      { protocol: 'https', hostname: 'gravatar.com' },
    ],
  },

  // CORS headers for development (allows local dev with external tools)
  async headers() {
    return [
      {
        source: '/_next/:path*',
        headers: [
          {
            key: 'Access-Control-Allow-Origin',
            value: '*',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
