const bcrypt = require("bcrypt");

async function hashPassword() {
  const password = "root123"; // Change this to your desired password
  const hashedPassword = await bcrypt.hash(password, 10);
  console.log("Hashed Password:", hashedPassword);
}

hashPassword();
