// const { MongoClient } = require("mongodb");
// require("dotenv").config();

// const uri = process.env.MONGODB_URI;
// const client = new MongoClient(uri);

// async function connectToDatabase() {
//   try {
//     await client.connect();
//     console.log("Connected to MongoDB Atlas");
//     return client.db("tanikala");
//   } catch (err) {
//     console.error("Failed to connect to MongoDB", err);
//     throw err;
//   }
// }

// module.exports = connectToDatabase;

const { MongoClient } = require("mongodb");
require("dotenv").config();

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

async function connectToDatabase() {
  try {
    await client.connect();
    console.log("Connected to MongoDB Atlas");
    return client.db("tanikala");
  } catch (err) {
    console.error("Failed to connect to MongoDB", err);
    throw err;
  }
}

module.exports = { connectToDatabase, client };
