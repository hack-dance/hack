import { Database } from "bun:sqlite";

const db = new Database("/data/proof.sqlite");
db.exec("CREATE TABLE IF NOT EXISTS proof(id INTEGER PRIMARY KEY,value TEXT)");
db.query("INSERT OR IGNORE INTO proof VALUES (1,?)").run(crypto.randomUUID());
db.close();
