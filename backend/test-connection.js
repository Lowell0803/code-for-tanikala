const connectToDatabase = require("../db");

(async () => {
  try {
    const db = await connectToDatabase();
    console.log("Database name:", db.databaseName);
    process.exit(0);
  } catch (err) {
    console.error("Error during connection test:", err);
    process.exit(1);
  }
})();
