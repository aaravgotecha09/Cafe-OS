import { Pool } from "pg";
import { execSync } from "child_process";
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL || "postgresql://cafe:cafe@localhost:5432/cafeos_test";
  const admin = new Pool({ connectionString: url.replace(/\/[^/]+$/, "/postgres") });
  const name = new URL(url).pathname.slice(1);
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  execSync("npx tsx src/db/migrate.ts", { env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
}
