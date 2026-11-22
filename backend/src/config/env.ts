import "dotenv/config";
const need = (k: string, dev?: string) => {
  const v = process.env[k] ?? (process.env.NODE_ENV === "production" ? undefined : dev);
  if (v === undefined) throw new Error(`Missing required env var ${k}`);
  return v;
};
export const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: Number(process.env.PORT || 4000),
  DATABASE_URL: need("DATABASE_URL", "postgresql://cafe:cafe@localhost:5432/cafeos"),
  JWT_ACCESS_SECRET: need("JWT_ACCESS_SECRET", "dev-access-secret-change-me"),
  JWT_REFRESH_SECRET: need("JWT_REFRESH_SECRET", "dev-refresh-secret-change-me"),
  QR_SIGNING_SECRET: need("QR_SIGNING_SECRET", "dev-qr-secret-change-me"),
  FRONTEND_URL: process.env.FRONTEND_URL || "http://localhost:3000",
  BACKEND_URL: process.env.BACKEND_URL || "http://localhost:4000",
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || "",
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || "",
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || "",
  PAYMENT_TEST_MODE: (process.env.PAYMENT_TEST_MODE ?? (process.env.NODE_ENV === "production" ? "false" : "true")) === "true",
  RESEND_API_KEY: process.env.RESEND_API_KEY || "",
  EMAIL_FROM: process.env.EMAIL_FROM || "Orange & Oak <onboarding@resend.dev>",
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "",
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || "",
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || "",
};
