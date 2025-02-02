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

        const collection_lsc = db.collection("candidates_lsc");
        const data_lsc = await collection_lsc.find({}).toArray();
        const structuredData = data_lsc.map((collegeDoc) => {
          const college = {
            collegeName: collegeDoc.collegeName,
            collegeAcronym: collegeDoc.collegeAcronym,
            positions: {},
          };

          collegeDoc.positions.forEach((positionDoc) => {
            const position = positionDoc.position;

            // If it's a Board Member position, group by program
            if (position === "Board Member" && positionDoc.programs) {
              college.positions[position] = positionDoc.programs.reduce(
                (programMap, programDoc) => {
                  programMap[programDoc.program] = programDoc.candidates;
                  return programMap;
                },
                {}
              );
            } else {
              // For other positions (Governor, Vice Governor), just map them normally
              college.positions[position] = positionDoc.candidates;
            }
          });
          return college;
        });

        console.log(structuredData);

        res.render("admin/dashboard", {
          candidates: allCandidates,
          candidates_lsc: structuredData,
        });
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

    // app.post("/update-candidate-lsc", async (req, res) => {
    //   try {
    //     const {
    //       _id,
    //       candidatePosition,
    //       party,
    //       name,
    //       moreInfo,
    //       image,
    //       collegeAcronym,
    //       program,
    //     } = req.body;

    //     if (!_id || !candidatePosition || !collegeAcronym) {
    //       return res.status(400).json({ error: "Missing required fields." });
    //     }

    //     console.log("🔍 Debugging update-candidate-lsc:");
    //     console.log("Received Data:", req.body);

    //     // Find the college document based on the collegeAcronym
    //     const college = await db
    //       .collection("candidates_lsc")
    //       .findOne({ collegeAcronym });

    //     if (!college) {
    //       console.log(`❌ College with acronym '${collegeAcronym}' not found.`);
    //       return res
    //         .status(404)
    //         .json({ error: `College '${collegeAcronym}' not found.` });
    //     }

    //     console.log("✅ College Found:", college.collegeName);

    //     let updated = false;

    //     console.log(`🔍 Searching position '${candidatePosition}'`);
    //     console.log("🔍 Available Positions:", Object.keys(college.positions));

    //     let convertedCandidatePosition = "0";
    //     if (candidatePosition == "Governor") {
    //       convertedCandidatePosition = "0";
    //     }
    //     if (candidatePosition == "Vice Governor") {
    //       convertedCandidatePosition = "1";
    //     }
    //     if (candidatePosition == "Board Member") {
    //       convertedCandidatePosition = "2";
    //     }

    //     if (convertedCandidatePosition === "2" && program) {
    //       console.log(`🔍 Searching Board Member in program '${program}'`);

    //       if (
    //         college.positions["Board Member"] &&
    //         college.positions["Board Member"][program]
    //       ) {
    //         console.log("✅ Program found inside Board Member.");

    //         college.positions["Board Member"][program] = college.positions[
    //           "Board Member"
    //         ][program].map((candidate) => {
    //           console.log(`Checking Candidate: ${candidate._id}`);
    //           if (candidate._id === _id) {
    //             console.log(
    //               `✅ Match found for candidate ID: ${_id}, updating...`
    //             );
    //             updated = true;
    //             return { ...candidate, party, name, moreInfo, image };
    //           }
    //           return candidate;
    //         });
    //       } else {
    //         console.log(`❌ Program '${program}' not found in Board Member.`);
    //       }
    //     } else {
    //       console.log(`🔍 Searching position '${convertedCandidatePosition}'`);
    //       console.log(college.positions);
    //       if (college.positions[convertedCandidatePosition]) {
    //         console.log("✅ Position found.");

    //         college.positions[convertedCandidatePosition] = college.positions[
    //           convertedCandidatePosition
    //         ].map((candidate) => {
    //           console.log(`Checking Candidate: ${candidate._id}`);
    //           if (candidate._id === _id) {
    //             console.log(
    //               `✅ Match found for candidate ID: ${_id}, updating...`
    //             );
    //             updated = true;
    //             return { ...candidate, party, name, moreInfo, image };
    //           }
    //           return candidate;
    //         });
    //       } else {
    //         console.log(
    //           `❌ Position '${convertedCandidatePosition}' not found.`
    //         );
    //       }
    //     }

    //     if (!updated) {
    //       console.log(`❌ Candidate with ID '${_id}' not found.`);
    //       return res.status(404).json({ error: "Candidate not found." });
    //     }

    //     // Save the updated document back to the database
    //     await db
    //       .collection("candidates_lsc")
    //       .updateOne(
    //         { collegeAcronym },
    //         { $set: { positions: college.positions } }
    //       );

    //     console.log("✅ Candidate updated successfully.");
    //     res.status(200).json({ message: "Candidate updated successfully." });
    //   } catch (error) {
    //     console.error("❌ Error updating candidate:", error);
    //     res.status(500).json({ error: "Internal server error." });
    //   }
    // });

    app.post("/update-candidate-lsc", async (req, res) => {
      try {
        let {
          _id,
          candidatePosition,
          party,
          name,
          moreInfo,
          image,
          collegeAcronym,
          program,
          originalImage,
        } = req.body;

        if (!_id || !candidatePosition || !collegeAcronym) {
          return res.status(400).json({ error: "Missing required fields." });
        }

        console.log("🔍 Debugging update-candidate-lsc:");
        console.log("Received Data:", req.body);

        if (!image || image.trim() === "") {
          image = originalImage;
        }

        // Find the college document based on the collegeAcronym
        const college = await db
          .collection("candidates_lsc")
          .findOne({ collegeAcronym });

        if (!college) {
          console.log(`❌ College with acronym '${collegeAcronym}' not found.`);
          return res
            .status(404)
            .json({ error: `College '${collegeAcronym}' not found.` });
        }

        console.log("✅ College Found:", college.collegeName);

        let updated = false;

        // Search for the position by name in the positions array
        console.log(`🔍 Searching position '${candidatePosition}'`);
        console.log(
          "🔍 Available Positions:",
          college.positions.map((pos) => pos.position)
        );

        let positionFound = college.positions.find(
          (pos) => pos.position === candidatePosition
        );

        if (!positionFound) {
          console.log(`❌ Position '${candidatePosition}' not found.`);
          return res
            .status(404)
            .json({ error: `Position '${candidatePosition}' not found.` });
        }

        console.log("✅ Position found:", positionFound);

        // Handle the Board Member position with programs
        if (candidatePosition === "Board Member" && program) {
          console.log(`🔍 Searching Board Member in program '${program}'`);

          if (positionFound.programs) {
            const programFound = positionFound.programs.find(
              (prog) => prog.program === program
            );

            if (programFound) {
              console.log("✅ Program found inside Board Member.");

              // Find and update the candidate within the program
              programFound.candidates = programFound.candidates.map(
                (candidate) => {
                  if (candidate._id === _id) {
                    console.log(
                      `✅ Match found for candidate ID: ${_id}, updating...`
                    );
                    updated = true;
                    return { ...candidate, party, name, moreInfo, image };
                  }
                  return candidate;
                }
              );
            } else {
              console.log(`❌ Program '${program}' not found in Board Member.`);
            }
          } else {
            console.log(`❌ Program data not found in Board Member.`);
          }
        } else {
          // Handle other positions (e.g., Governor, Vice Governor)
          positionFound.candidates = positionFound.candidates.map(
            (candidate) => {
              if (candidate._id === _id) {
                console.log(
                  `✅ Match found for candidate ID: ${_id}, updating...`
                );
                updated = true;
                return { ...candidate, party, name, moreInfo, image };
              }
              return candidate;
            }
          );
        }

        if (!updated) {
          console.log(`❌ Candidate with ID '${_id}' not found.`);
          return res.status(404).json({ error: "Candidate not found." });
        }

        // Save the updated document back to the database
        await db
          .collection("candidates_lsc")
          .updateOne(
            { collegeAcronym },
            { $set: { positions: college.positions } }
          );

        // console.log("✅ Candidate updated successfully.");
        // res.status(200).json({ message: "Candidate updated successfully." });
        console.log(`Candidate with ID ${_id} updated successfully.`);
        res.redirect("/dashboard");
      } catch (error) {
        console.error("❌ Error updating candidate:", error);
        res.status(500).json({ error: "Internal server error." });
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
        const { _id, name, image, party, moreInfo, candidatePosition } =
          req.body;

        // If no new image is uploaded, use the original image
        if (!image || image === "") {
          image = "img/placeholder_admin_profile.png";
        }

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
          image,
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

    // app.post("/add-candidate-lsc", async (req, res) => {
    //   try {
    //     const {
    //       candidatePosition,
    //       party,
    //       name,
    //       moreInfo,
    //       image,
    //       collegeAcronym,
    //       program,
    //     } = req.body;

    //     if (!candidatePosition || !collegeAcronym || !name || !party) {
    //       return res.status(400).json({ error: "Missing required fields." });
    //     }

    //     // Default image if none is provided
    //     const candidateImage =
    //       image && image !== "" ? image : "img/placeholder_admin_profile.png";

    //     // Find the college document
    //     const college = await db
    //       .collection("candidates_lsc")
    //       .findOne({ collegeAcronym });

    //     if (!college) {
    //       return res
    //         .status(404)
    //         .json({ error: `College '${collegeAcronym}' not found.` });
    //     }

    //     console.log("✅ College Found:", college.collegeName);

    //     let positionFound = college.positions.find(
    //       (pos) => pos.position === candidatePosition
    //     );

    //     if (!positionFound) {
    //       return res
    //         .status(404)
    //         .json({ error: `Position '${candidatePosition}' not found.` });
    //     }

    //     console.log("✅ Position found:", positionFound);

    //     let newCandidateId;
    //     if (candidatePosition === "Board Member" && program) {
    //       // Handle Board Member (check program first)
    //       const programFound = positionFound.programs.find(
    //         (prog) => prog.program === program
    //       );

    //       if (!programFound) {
    //         return res
    //           .status(404)
    //           .json({ error: `Program '${program}' not found.` });
    //       }

    //       console.log("✅ Program found:", programFound.program);

    //       // Find highest existing `_id`
    //       const highestId = programFound.candidates.reduce((max, candidate) => {
    //         const match = candidate._id.match(/_(\d+)$/);
    //         return match ? Math.max(max, parseInt(match[1], 10)) : max;
    //       }, 0);

    //       newCandidateId = `board_member_${highestId + 1}`;

    //       // Add new candidate
    //       programFound.candidates.push({
    //         _id: newCandidateId,
    //         name,
    //         party,
    //         image: candidateImage,
    //         moreInfo,
    //         position: "board member",
    //         college: collegeAcronym,
    //         program,
    //       });
    //     } else {
    //       // Handle Governor and Vice Governor
    //       const highestId = positionFound.candidates.reduce(
    //         (max, candidate) => {
    //           const match = candidate._id.match(/_(\d+)$/);
    //           return match ? Math.max(max, parseInt(match[1], 10)) : max;
    //         },
    //         0
    //       );

    //       newCandidateId = `${candidatePosition
    //         .toLowerCase()
    //         .replace(" ", "_")}_${highestId + 1}`;

    //       positionFound.candidates.push({
    //         _id: newCandidateId,
    //         name,
    //         party,
    //         image: candidateImage,
    //         moreInfo,
    //         position: candidatePosition.toLowerCase(),
    //         college: collegeAcronym,
    //       });
    //     }

    //     // Update database
    //     await db
    //       .collection("candidates_lsc")
    //       .updateOne(
    //         { collegeAcronym },
    //         { $set: { positions: college.positions } }
    //       );

    //     console.log(
    //       `✅ New candidate '${name}' added with ID: ${newCandidateId}`
    //     );
    //     res.redirect("/dashboard");
    //   } catch (error) {
    //     console.error("❌ Error adding candidate:", error);
    //     res.status(500).json({ error: "Internal server error." });
    //   }
    // });

    app.post("/add-candidate-lsc", async (req, res) => {
      try {
        const {
          candidatePosition,
          party,
          name,
          moreInfo,
          image,
          collegeAcronym,
          program,
        } = req.body;

        if (!candidatePosition || !collegeAcronym || !name || !party) {
          return res.status(400).json({ error: "Missing required fields." });
        }

        // Default image if none is provided
        const candidateImage =
          image && image !== "" ? image : "img/placeholder_admin_profile.png";

        // Find the college document
        const college = await db
          .collection("candidates_lsc")
          .findOne({ collegeAcronym });

        if (!college) {
          return res
            .status(404)
            .json({ error: `College '${collegeAcronym}' not found.` });
        }

        console.log("✅ College Found:", college.collegeName);

        let positionFound = college.positions.find(
          (pos) => pos.position === candidatePosition
        );

        if (!positionFound) {
          return res
            .status(404)
            .json({ error: `Position '${candidatePosition}' not found.` });
        }

        console.log("✅ Position found:", positionFound);

        let newCandidateId;
        if (candidatePosition === "Board Member" && program) {
          // Handle Board Member (check program first)
          let programFound = positionFound.programs.find(
            (prog) => prog.program === program
          );

          if (!programFound) {
            // If program not found, create a new one
            programFound = { program, candidates: [] };
            positionFound.programs.push(programFound);
            console.log(`🔹 Created new program entry: ${program}`);
          }

          console.log("✅ Program found:", programFound.program);

          // Find highest existing `_id`
          const highestId = programFound.candidates.reduce((max, candidate) => {
            const match = candidate._id.match(/_(\d+)$/);
            return match ? Math.max(max, parseInt(match[1], 10)) : max;
          }, 0);

          newCandidateId = `board_member_${highestId + 1}`;

          // Add new candidate
          programFound.candidates.push({
            _id: newCandidateId,
            name,
            party,
            image: candidateImage,
            moreInfo,
            position: "board member",
            college: collegeAcronym,
            program,
          });
        } else {
          // Handle Governor and Vice Governor
          const highestId = positionFound.candidates.reduce(
            (max, candidate) => {
              const match = candidate._id.match(/_(\d+)$/);
              return match ? Math.max(max, parseInt(match[1], 10)) : max;
            },
            0
          );

          newCandidateId = `${candidatePosition
            .toLowerCase()
            .replace(" ", "_")}_${highestId + 1}`;

          positionFound.candidates.push({
            _id: newCandidateId,
            name,
            party,
            image: candidateImage,
            moreInfo,
            position: candidatePosition.toLowerCase(),
            college: collegeAcronym,
          });
        }

        // Update database
        await db
          .collection("candidates_lsc")
          .updateOne(
            { collegeAcronym },
            { $set: { positions: college.positions } }
          );

        console.log(
          `✅ New candidate '${name}' added with ID: ${newCandidateId}`
        );
        res.redirect("/dashboard");
      } catch (error) {
        console.error("❌ Error adding candidate:", error);
        res.status(500).json({ error: "Internal server error." });
      }
    });

    app.get("/api/candidates-lsc", async (req, res) => {
      try {
        const { position, college, program } = req.query;

        if (!position || !college) {
          return res
            .status(400)
            .json({ error: "Position and college are required." });
        }

        // Find the college document
        const collegeDoc = await db
          .collection("candidates_lsc")
          .findOne({ collegeAcronym: college });

        if (!collegeDoc) {
          return res
            .status(404)
            .json({ error: `College '${college}' not found.` });
        }

        console.log("✅ College Found:", collegeDoc.collegeName);

        // Find the position
        let positionFound = collegeDoc.positions.find(
          (pos) => pos.position === position
        );

        if (!positionFound) {
          return res
            .status(404)
            .json({ error: `Position '${position}' not found.` });
        }

        console.log("✅ Position Found:", positionFound);

        let candidates = [];

        if (position === "Board Member" && program) {
          // Handle Board Member with program filtering
          const programFound = positionFound.programs.find(
            (prog) => prog.program === program
          );

          if (!programFound) {
            return res
              .status(404)
              .json({ error: `Program '${program}' not found.` });
          }

          console.log("✅ Program Found:", program);
          candidates = programFound.candidates || [];
        } else {
          // For Governor and Vice Governor
          candidates = positionFound.candidates || [];
        }

        res.json({ candidates });
      } catch (error) {
        console.error("❌ Error fetching candidates:", error);
        res.status(500).json({ error: "Internal server error." });
      }
    });

    app.post("/delete-candidate", async (req, res) => {
      try {
        const { _id } = req.body;

        if (!_id) {
          return res.status(400).send("Candidate ID is required.");
        }

        const collection = db.collection("candidates");

        // Find the document containing the candidate and remove them from the candidates array
        const result = await collection.updateOne(
          { "candidates._id": _id },
          { $pull: { candidates: { _id: _id } } }
        );

        if (result.modifiedCount > 0) {
          console.log(`Candidate with ID ${_id} deleted successfully.`);
          res.status(200).send("Candidate deleted successfully.");
        } else {
          console.log(`No candidate found with ID ${_id}.`);
          res.status(404).send("Candidate not found.");
        }
      } catch (error) {
        console.error("Error deleting candidate:", error);
        res.status(500).send("Failed to delete candidate.");
      }
    });

    app.post("/delete-candidate-lsc", async (req, res) => {
      try {
        const { _id, candidatePosition, collegeAcronym, program } = req.body;

        if (!_id || !candidatePosition || !collegeAcronym) {
          return res.status(400).json({ error: "Missing required fields." });
        }

        console.log(`🔍 Attempting to delete candidate ID: ${_id}`);

        // Find the college document
        const college = await db
          .collection("candidates_lsc")
          .findOne({ collegeAcronym });

        if (!college) {
          return res
            .status(404)
            .json({ error: `College '${collegeAcronym}' not found.` });
        }

        console.log("✅ College Found:", college.collegeName);

        let positionFound = college.positions.find(
          (pos) => pos.position === candidatePosition
        );

        if (!positionFound) {
          return res
            .status(404)
            .json({ error: `Position '${candidatePosition}' not found.` });
        }

        console.log("✅ Position Found:", candidatePosition);

        let updated = false;

        if (candidatePosition === "Board Member" && program) {
          // Find the correct program within Board Member
          let programFound = positionFound.programs.find(
            (prog) => prog.program === program
          );

          if (!programFound) {
            return res
              .status(404)
              .json({ error: `Program '${program}' not found.` });
          }

          console.log("✅ Program Found:", program);

          // Remove the candidate
          const newCandidates = programFound.candidates.filter(
            (candidate) => candidate._id !== _id
          );
          if (newCandidates.length !== programFound.candidates.length) {
            programFound.candidates = newCandidates;
            updated = true;
          }
        } else {
          // For Governor and Vice Governor
          const newCandidates = positionFound.candidates.filter(
            (candidate) => candidate._id !== _id
          );
          if (newCandidates.length !== positionFound.candidates.length) {
            positionFound.candidates = newCandidates;
            updated = true;
          }
        }

        if (!updated) {
          return res.status(404).json({ error: "Candidate not found." });
        }

        // Update database
        await db
          .collection("candidates_lsc")
          .updateOne(
            { collegeAcronym },
            { $set: { positions: college.positions } }
          );

        console.log(`✅ Candidate '${_id}' deleted successfully.`);
        res.redirect("/dashboard");
      } catch (error) {
        console.error("❌ Error deleting candidate:", error);
        res.status(500).json({ error: "Internal server error." });
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
