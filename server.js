const express = require("express");
const path = require("path");
const connectToDatabase = require("./db");

const bodyParser = require("body-parser");

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, "public")));

app.use(express.json({ limit: "10mb" })); // Adjust size if needed
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

let db;

const startServer = async () => {
  try {
    db = await connectToDatabase();
    console.log("Connected to the database successfully!");

    // app.post("/update-candidate", async (req, res) => {
    //   try {
    //     const { id, name, party, moreInfo } = req.body;

    //     if (!id || !name || !party || !moreInfo) {
    //       return res.status(400).send("All fields are required.");
    //     }

    //     const collection = db.collection("candidates_lsc");

    //     // Update the candidate's details
    //     const result = await collection.updateOne(
    //       { "candidates._id": id }, // Find candidate by `_id`
    //       {
    //         $set: {
    //           "candidates.$.name": name,
    //           "candidates.$.party": party,
    //           "candidates.$.moreInfo": moreInfo,
    //         },
    //       }
    //     );

    //     if (result.matchedCount === 0) {
    //       return res.status(404).send("Candidate not found.");
    //     }

    //     res.status(200).send("Candidate information updated successfully!");
    //   } catch (error) {
    //     console.error("Error updating candidate:", error);
    //     res.status(500).send("Failed to update candidate information.");
    //   }
    // });

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

        const voterCollege = req.user ? req.user.college : "CAL";
        const voterProgram = req.user
          ? req.user.program
          : "Bachelor of Performing Arts";

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

    app.get("/dashboard", async (req, res) => {
      try {
        const collection = db.collection("candidates");
        const data = await collection.find({}).toArray();
        const allCandidates = data.map((doc) => doc.candidates).flat();

        // console.log(allCandidates);

        // Render the dashboard with candidatesData
        res.render("admin/dashboard", { candidates: allCandidates });
      } catch (error) {
        console.error("Error fetching candidates for dashboard:", error);
        res
          .status(500)
          .send("Failed to fetch candidates data for the dashboard");
      }
    });

    app.post("/update-candidate", async (req, res) => {
      console.log("Form data:", req.body);
      try {
        let {
          _id,
          image,
          originalImage,
          name,
          party,
          moreInfo,
          candidatePosition,
        } = req.body;

        // If no new image is uploaded, use the original image
        if (!image || image === "") {
          image = originalImage;
        }

        console.log("Updating candidate with ID:", _id);
        // console.log("Final Image:", image); // Debugging

        const collection = db.collection("candidates");

        const result = await collection.updateOne(
          { "candidates._id": String(_id) },
          {
            $set: {
              "candidates.$.name": name,
              "candidates.$.party": party,
              "candidates.$.image": image,
              "candidates.$.moreInfo": moreInfo,
            },
          }
        );

        console.log("Update result:", result);

        if (result.modifiedCount > 0) {
          console.log(`Candidate with ID ${_id} updated successfully.`);
          res.redirect("/dashboard");
        } else {
          console.log(`No candidate found with ID ${_id}.`);
          res.status(404).send("Candidate not found.");
        }
      } catch (error) {
        console.error("Error updating candidate:", error);
        res.status(500).send("Failed to update candidate.");
      }
    });

    app.get("/api/candidates", async (req, res) => {
      try {
        const { position } = req.query;
        if (!position) {
          return res.status(400).json({ error: "Position is required" });
        }

        const collection = db.collection("candidates"); // Ensure this is the correct collection

        // Use case-insensitive search for the position
        const result = await collection.findOne({
          position: { $regex: new RegExp(`^${position}$`, "i") }, // Case-insensitive match
        });

        if (!result) {
          return res.status(404).json({ error: "Position not found" });
        }

        res.json(result);
      } catch (error) {
        console.error("Error fetching candidates:", error);
        res
          .status(500)
          .json({ error: "Internal server error", details: error.message });
      }
    });

    app.post("/add-candidate", async (req, res) => {
      try {
        const { _id, name, party, moreInfo, candidatePosition } = req.body;

        const collection = db.collection("candidates");

        // Find the position document
        const positionData = await collection.findOne({
          position: candidatePosition,
        });

        if (!positionData) {
          return res.status(404).send("Position not found.");
        }

        // Create the new candidate object
        const newCandidate = {
          _id: String(_id),
          name,
          party,
          image: "img/placeholder_admin_profile.png", // Default image
          moreInfo,
          position: candidatePosition.toLowerCase(),
        };

        console.log(newCandidate);

        // Push new candidate into the candidates array
        const result = await collection.updateOne(
          { position: candidatePosition },
          { $push: { candidates: newCandidate } }
        );

        if (result.modifiedCount > 0) {
          console.log(`Candidate ${name} added successfully.`);
          res.redirect("/dashboard");
        } else {
          res.status(500).send("Failed to add candidate.");
        }
      } catch (error) {
        console.error("Error adding candidate:", error);
        res.status(500).send("Internal Server Error");
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
