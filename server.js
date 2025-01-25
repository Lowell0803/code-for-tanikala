const express = require("express");
const path = require("path");
const connectToDatabase = require("./db");

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, "public")));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

let db;

const startServer = async () => {
  try {
    db = await connectToDatabase();
    console.log("Connected to the database successfully!");

    app.get("/", (req, res) => {
      res.sendFile(path.join(__dirname, "public", "index.html"));
    });

    app.get("/vote", async (req, res) => {
      try {
        const collection = db.collection("candidates");
        const data = await collection.find({}).toArray();
        const allCandidates = data.map((doc) => doc.candidates).flat();

        // const collectionLSC = db.collection("candidates_lsc");
        // const dataLSC = await collectionLSC.find({}).toArray();
        // const allCandidatesLSC = dataLSC.map((doc) => doc.candidates).flat();

        // // define collectionLSC, dataLSC, allCandidatesLSC here with the db.collection named candidates_lsc

        const collectionLSC = db.collection("candidates_lsc");
        const dataLSC = await collectionLSC.find({}).toArray();
        const allCandidatesLSC = dataLSC
          .map((doc) =>
            doc.positions.flatMap((position) => position.candidates || [])
          )
          .flat();

        console.log("Candidates fetched from the database:", allCandidates);
        console.log("Candidates fetched from the database:", allCandidatesLSC);
        res.render("voter/vote", {
          candidates: allCandidates,
          candidates_lsc: allCandidatesLSC,
        });
      } catch (error) {
        console.error("Error fetching candidates:", error);
        res.status(500).send("Failed to fetch candidates");
      }
    });

    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to connect to the database:", error);
    process.exit(1);
  }
};

startServer();
