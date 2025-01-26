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
        // Data from the logged in account
        // const voterCollege = req.user ? req.user.college : "CAFA";
        // const voterProgram = req.user
        //   ? req.user.program
        //   : "Bachelor of Fine Arts Major in Visual Communication";

        const voterCollege = req.user ? req.user.college : "CBEA";
        const voterProgram = req.user
          ? req.user.program
          : "Bachelor of Science in Entrepreneurship";

        const collection = db.collection("candidates");
        const data = await collection.find({}).toArray();
        const allCandidates = data.map((doc) => doc.candidates).flat();

        const collectionLSC = db.collection("candidates_lsc");
        const dataLSC = await collectionLSC.find({}).toArray();
        const allCandidatesLSC = dataLSC
          .map((doc) =>
            doc.positions.flatMap((position) => position.candidates || [])
          )
          .flat();

        const collectionLSCBoardMembers = db.collection("candidates_lsc");

        // Fetch all data from the collection
        const dataLSCBoardmembers = await collectionLSCBoardMembers
          .find({})
          .toArray();

        // Extract all board members by filtering positions
        // const allBoardMembers = dataLSC
        //   .map((doc) =>
        //     doc.positions
        //       .filter((position) => position.position === "Board Member")
        //       .flatMap((position) => position.programs)
        //       .flatMap((program) => program.candidates)
        //   )
        //   .flat();

        // const allBoardMembers = dataLSC
        //   .map((doc) =>
        //     doc.positions
        //       .filter((position) => position.position === "Board Member")
        //       .flatMap((position) => position.programs)
        //       .flatMap((program) => {
        //         // Log each program before adding to the flatMap result
        //         // console.log("Program:", program.program);
        //         console.log(program.candidates);
        //         return program.candidates;
        //       })
        //   )
        //   .flat();

        const allBoardMembers = dataLSC
          .map((doc) =>
            doc.positions
              .filter((position) => position.position === "Board Member")
              .flatMap((position) => position.programs)
              .flatMap((program) => {
                // Log each program before adding to the flatMap result
                console.log("Program:", program);

                // Add program.program inside each candidate object
                program.candidates.forEach((candidate) => {
                  candidate.program = program.program; // Add program.program to each candidate
                });

                console.log("Updated candidates:", program.candidates);

                return program.candidates;
              })
          )
          .flat();

        // console.log("Candidates fetched from the database:", allCandidates);
        // console.log("Candidates fetched from the database:", allBoardMembers);

        // Pass voterCollege to the EJS template
        res.render("voter/vote", {
          candidates: allCandidates,
          candidates_lsc: allCandidatesLSC,
          lsc_board_members: allBoardMembers,
          voterCollege, // Dynamically pass the voter's college
          voterProgram,
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
