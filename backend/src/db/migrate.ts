import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "path";
import { db, pool } from "./index";
(async () => {
  await migrate(db, { migrationsFolder: path.join(__dirname, "../../drizzle") });
  console.log("Migrations applied");
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
