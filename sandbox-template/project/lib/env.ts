// Environment variable validation
// Validates required env vars at build/runtime to catch issues early

import { z } from 'zod';

// Server-side environment variables (not exposed to client)
const serverEnvSchema = z.object({
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  DB_NAME: z.string().min(1, 'DB_NAME is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  // Cloudinary (optional)
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  // OpenRouter (optional)
  OPENROUTER_API_KEY: z.string().optional(),
});

// Client-side environment variables (exposed via NEXT_PUBLIC_)
const clientEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url('NEXT_PUBLIC_API_URL must be a valid URL').optional(),
});

// Only validate server env on server side
function getServerEnv() {
  if (typeof window !== 'undefined') {
    // Return empty object on client side
    return {} as z.infer<typeof serverEnvSchema>;
  }

  // During build time, don't throw - just return what we have
  const isBuildTime = process.env.NODE_ENV === 'production' && !process.env.MONGODB_URI;

  const parsed = serverEnvSchema.safeParse({
    MONGODB_URI: process.env.MONGODB_URI,
    DB_NAME: process.env.DB_NAME,
    JWT_SECRET: process.env.JWT_SECRET,
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  });

  if (!parsed.success) {
    if (isBuildTime) {
      // During build, return empty values - they'll be validated at runtime
      console.warn('⚠️ Server environment variables not set (expected during build)');
      return {
        MONGODB_URI: '',
        DB_NAME: '',
        JWT_SECRET: '',
        CLOUDINARY_CLOUD_NAME: undefined,
        CLOUDINARY_API_KEY: undefined,
        CLOUDINARY_API_SECRET: undefined,
        OPENROUTER_API_KEY: undefined,
      } as z.infer<typeof serverEnvSchema>;
    }
    console.error('❌ Invalid server environment variables:');
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error('Invalid server environment variables');
  }

  return parsed.data;
}

// Client env is always available
function getClientEnv() {
  const parsed = clientEnvSchema.safeParse({
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  });

  if (!parsed.success) {
    console.error('❌ Invalid client environment variables:');
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error('Invalid client environment variables');
  }

  return parsed.data;
}

// Export validated environment variables
export const serverEnv = getServerEnv();
export const clientEnv = getClientEnv();

// Combined env for convenience (use carefully - don't expose server env to client)
export const env = {
  ...serverEnv,
  ...clientEnv,
};
