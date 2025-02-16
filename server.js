const express = require("express");
const path = require("path");
const connectToDatabase = require("./db");
const bodyParser = require("body-parser");
const { ethers } = require("ethers");
require("dotenv").config();

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

let db;

const { Mutex } = require("async-mutex");
const PQueue = require("p-queue").default;

const nonceMutex = new Mutex(); // Mutex to lock nonce updates
const voteQueue = new PQueue({ concurrency: 1 }); // Queue for sequential vote processing

const startServer = async () => {
  try {
    db = await connectToDatabase();
    console.log("Connected to the database successfully!");

    // const voterCollege = req.user ? req.user.college : "CAL";
    // const voterProgram = req.user
    //   ? req.user.program
    //   : "Bachelor of Performing Arts";

    app.get("/", (req, res) => {
      res.sendFile(path.join(__dirname, "public", "index.html"));
    });

    // TEST IF CANDIDATES IS SUBMITTED TO BLOCKCHAIN

    app.get("/get-candidates", async (req, res) => {
      try {
        console.log("📡 Fetching candidates from blockchain...");

        let candidatesData = {};

        // ✅ Main Election Positions (No Acronyms)
        const mainPositions = ["President", "Vice President", "Senator"];
        for (const position of mainPositions) {
          const candidates = await contract.getCandidates(position);
          console.log(`✅ Retrieved ${candidates.length} candidates for ${position}`);
          candidatesData[position] = candidates.map((c) => ({
            name: c.name,
            party: c.party,
            position: c.position,
          }));
        }

        // ✅ LSC Positions (Now Includes College Acronyms)
        const collegeAcronyms = ["CAFA", "CAL", "CBEA"]; // Add more if needed
        const lscPositions = ["Governor", "Vice Governor"];
        for (const basePosition of lscPositions) {
          for (const acronym of collegeAcronyms) {
            const fullPosition = `${basePosition} - ${acronym}`;
            const candidates = await contract.getCandidates(fullPosition);
            console.log(`✅ Retrieved ${candidates.length} candidates for ${fullPosition}`);
            candidatesData[fullPosition] = candidates.map((c) => ({
              name: c.name,
              party: c.party,
              position: c.position,
            }));
          }
        }

        // ✅ Board Members (Program-Specific)
        const boardMemberPrograms = [
          "Bachelor of Science in Architecture",
          "Bachelor of Fine Arts Major in Visual Communication",
          "Bachelor of Landscape Architecture",
          "Bachelor of Arts in Broadcasting",
          "Bachelor of Arts in Journalism",
          "Bachelor of Performing Arts",
          "Bachelor of Science in Accountancy/Accounting Information System",
          "Bachelor of Science in Business Administration",
          "Bachelor of Science in Entrepreneurship",
        ];
        for (const program of boardMemberPrograms) {
          const fullPosition = `Board Member - ${program}`;
          const candidates = await contract.getCandidates(fullPosition);
          console.log(`✅ Retrieved ${candidates.length} candidates for ${fullPosition}`);
          candidatesData[fullPosition] = candidates.map((c) => ({
            name: c.name,
            party: c.party,
            position: c.position,
          }));
        }

        console.log("📌 Final Candidates Data:", JSON.stringify(candidatesData, null, 2));

        res.json({ success: true, candidates: candidatesData });
      } catch (error) {
        console.error("❌ Error fetching candidates:", error);
        res.status(500).json({ success: false, error: "Failed to fetch candidates." });
      }
    });

    app.get("/developer/debug-candidates", async (req, res) => {
      try {
        console.log("📡 Fetching candidates from blockchain...");
        let candidatesData = {};

        const positions = ["President", "Vice President", "Senator", "Governor", "Vice Governor", "Board Member"];
        for (const position of positions) {
          const candidates = await contract.getCandidates(position);
          console.log(`✅ Candidates for ${position}:`, candidates);

          candidatesData[position] = candidates.map((c) => ({
            name: c.name,
            party: c.party,
            position: c.position,
            votes: c.votes.toString(),
          }));
        }

        res.json({ success: true, candidates: candidatesData });
      } catch (error) {
        console.error("❌ Error fetching candidates:", error);
        res.status(500).json({ success: false, error: "Failed to fetch candidates." });
      }
    });

    app.get("/developer/vote-counts", async (req, res) => {
      try {
        console.log("📡 Fetching vote counts...");
        const candidates = await contract.getVoteCounts();

        const results = candidates.map((c) => ({
          candidate: c.name,
          position: c.position,
          votes: c.votes.toString(),
        }));

        console.log("✅ Vote counts retrieved:", results);
        res.json({ success: true, results });
      } catch (error) {
        console.error("❌ Error fetching vote counts:", error);
        res.status(500).json({ success: false, error: "Failed to fetch vote counts." });
      }
    });

    function formatPosition(position) {
      console.log("🔍 Raw position input:", position);

      const lscPositions = ["Governor", "Vice Governor"];
      const boardMemberPrefix = "Board Member - ";

      // ✅ Handle Board Members (e.g., "board_member_bachelor_of_science_in_architecture" → "Board Member - Bachelor of Science in Architecture")
      if (position.toLowerCase().startsWith("board_member")) {
        const programName = position.replace("board_member_", "").replace(/_/g, " ");
        const formattedProgram = programName.replace(/\b\w/g, (char) => char.toUpperCase()); // Capitalize words
        console.log("✅ Matched Board Member position:", `${boardMemberPrefix}${formattedProgram}`);
        return `${boardMemberPrefix}${formattedProgram}`;
      }

      // ✅ Handle LSC Positions (Governor / Vice Governor with College Acronyms)
      for (const base of lscPositions) {
        if (position.toLowerCase().startsWith(base.toLowerCase().replace(" ", "_"))) {
          const parts = position.split("_"); // Example: ["governor", "cafa"]
          if (parts.length === 2) {
            const acronym = parts[1].toUpperCase();
            console.log("✅ Matched LSC position:", `${base} - ${acronym}`);
            return `${base} - ${acronym}`;
          }
        }
      }

      // ✅ Convert other positions (e.g., "vice_president" → "Vice President")
      let formattedPosition = position
        .replace(/_/g, " ") // Convert underscores to spaces
        .replace(/\s*-\s*/g, " - ") // Ensure proper spacing around dashes
        .replace(/\b\w/g, (char) => char.toUpperCase()); // Capitalize each word

      console.log("✅ Final formatted position:", formattedPosition);
      return position;
    }

    app.post("/submit-vote", async (req, res) => {
      const queuePosition = voteQueue.size;
      voteQueue.add(async () => {
        try {
          const { votes } = req.body;
          console.log("📡 Processing vote submission:", votes);

          let nonce = await provider.getTransactionCount(wallet.address, "pending"); // ✅ Use "pending" for better concurrency
          const positions = Object.keys(votes);
          const transactions = [];

          for (const position of positions) {
            const formattedPosition = formatPosition(position);
            const voteData = votes[position];

            if (Array.isArray(voteData)) {
              for (const candidate of voteData) {
                const index = await findCandidateIndex(formattedPosition, candidate.name);
                if (index === -1) {
                  console.log(`❌ Candidate ${candidate.name} not found in ${formattedPosition}! Skipping.`);
                  continue;
                }
                console.log(`✅ Voting for ${candidate.name} in ${formattedPosition} (index ${index})`);

                const tx = await contract.connect(wallet).vote(formattedPosition, index, { nonce: nonce++ });
                await tx.wait();
                transactions.push({ candidate: candidate.name, position: formattedPosition, txHash: tx.hash });
              }
            } else {
              const index = await findCandidateIndex(formattedPosition, voteData.name);
              if (index === -1) {
                console.log(`❌ Candidate ${voteData.name} not found in ${formattedPosition}! Skipping.`);
                continue;
              }
              console.log(`✅ Voting for ${voteData.name} in ${formattedPosition} (index ${index})`);

              const tx = await contract.connect(wallet).vote(formattedPosition, index, { nonce: nonce++ });
              await tx.wait();
              transactions.push({ candidate: voteData.name, position: formattedPosition, txHash: tx.hash });
            }
          }

          console.log("✅ All votes submitted successfully!");
          res.status(200).json({
            message: "Votes successfully submitted to blockchain!",
            queuePosition: queuePosition,
            transactions: transactions, // Return transaction hashes
          });
        } catch (error) {
          console.error("❌ Error submitting votes:", error);
          res.status(500).json({ error: "Failed to submit votes." });
        }
      });
    });

    app.get("/get-queue-position", (req, res) => {
      res.json({ position: voteQueue.size + 1 });
    });

    // ✅ Helper Function to Get Candidate Index from Blockchain
    async function findCandidateIndex(position, candidateName) {
      const candidates = await contract.getCandidates(position);

      console.log(`🔍 Searching for '${candidateName}' in ${position}...`);

      for (let i = 0; i < candidates.length; i++) {
        const storedName = candidates[i].name.trim().toLowerCase();
        if (storedName === candidateName.trim().toLowerCase()) {
          console.log(`✅ Found ${candidateName} at index ${i}`);
          return i;
        }
      }

      console.log(`❌ Candidate '${candidateName}' not found in ${position}`);
      return -1;
    }

    app.post("/reset-candidates", async (req, res) => {
      try {
        const tx = await contract.resetCandidates();
        await tx.wait();
        res.json({ message: "Candidates reset. You can now submit again." });
      } catch (error) {
        console.error("Error resetting candidates:", error);
        res.status(500).json({ error: "Failed to reset candidates." });
      }
    });

    // ==========================
    // BLOCKCHAIN SETUP (HARDHAT)
    // ==========================

    const provider = new ethers.JsonRpcProvider(process.env.HARDHAT_RPC_URL);
    const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);

    const contractABI = require("./artifacts/contracts/AdminCandidates.sol/AdminCandidates.json").abi;
    const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, contractABI, wallet);

    // API Route: Submit Candidates from MongoDB to Blockchain
    app.post("/submit-candidates", async (req, res) => {
      try {
        const candidatesCollection = db.collection("candidates");
        const candidatesLscCollection = db.collection("candidates_lsc");

        // Fetch candidates from both collections
        const candidatesData = await candidatesCollection.find({}).toArray();
        const candidatesLscData = await candidatesLscCollection.find({}).toArray();

        console.log("\n🚀 SUBMIT-CANDIDATES API CALLED!");
        console.log("✅ Main candidates fetched:", candidatesData.length);
        console.log("✅ LSC candidates fetched:", candidatesLscData.length);
        // console.log("📜 Raw LSC Data from MongoDB:\n", JSON.stringify(candidatesLscData, null, 2));

        let positions = [];
        let names = [];
        let parties = [];

        // Process main candidates collection
        candidatesData.forEach((group) => {
          if (group.candidates.length === 0) {
            console.log(`❌ Skipping ${group.position} (No candidates)`);
          } else {
            console.log(`✅ Adding ${group.position} with ${group.candidates.length} candidates`);
            positions.push(group.position);
            names.push(group.candidates.map((c) => c.name));
            parties.push(group.candidates.map((c) => c.party));
          }
        });

        // Process LSC candidates collection
        candidatesLscData.forEach((college) => {
          console.log(`\n📌 Processing LSC College: ${college.collegeName}`);

          college.positions.forEach((pos) => {
            if (pos.position === "Board Member") {
              pos.programs.forEach((program) => {
                if (!program.candidates || program.candidates.length === 0) {
                  console.log(`❌ Skipping Board Member - ${program.program} (No candidates)`);
                } else {
                  console.log(`✅ Adding Board Member - ${program.program} with ${program.candidates.length} candidates`);
                  positions.push(`Board Member - ${program.program}`);
                  names.push(program.candidates.map((c) => c.name));
                  parties.push(program.candidates.map((c) => c.party));
                }
              });
            } else {
              if (!pos.candidates || pos.candidates.length === 0) {
                console.log(`❌ Skipping ${pos.position} for ${college.collegeAcronym} (No candidates)`);
              } else {
                console.log(`✅ Adding ${pos.position} for ${college.collegeAcronym} with ${pos.candidates.length} candidates`);
                positions.push(`${pos.position} - ${college.collegeAcronym}`);
                names.push(pos.candidates.map((c) => c.name));
                parties.push(pos.candidates.map((c) => c.party));
              }
            }
          });
        });

        // ✅ Add "Abstain" to every position (MINIMAL CHANGE)
        positions.forEach((pos, index) => {
          names[index].push("Abstain");
          parties[index].push("None"); // "None" indicates no party affiliation
        });

        console.log("\n📌 FINAL SUBMISSION:");
        console.log({ positions, names, parties });

        if (positions.length === 0) {
          console.log("⚠️ No candidates to submit!");
          return res.status(400).json({ error: "No candidates to submit." });
        }

        console.log("📡 Sending transaction to blockchain...");
        const tx = await contract.submitCandidates(positions, names, parties);
        await tx.wait();
        console.log("✅ Candidates submitted successfully!");

        res.json({ message: "Candidates successfully submitted to blockchain!" });
      } catch (error) {
        console.error("❌ ERROR submitting candidates:", error);
        res.status(500).json({ error: "Failed to submit candidates." });
      }
    });

    // ==========================
    // BACKEND SETUP (EXPRESS)
    // ==========================

    app.get("/vote", async (req, res) => {
      try {
        // Data from the logged in account
        const voterCollege = req.user ? req.user.college : "CAFA";
        const voterProgram = req.user ? req.user.program : "Bachelor of Fine Arts Major in Visual Communication";

        const collection = db.collection("candidates");
        const data = await collection.find({}).toArray();
        const allCandidates = data.map((doc) => doc.candidates).flat();

        const collectionLSC = db.collection("candidates_lsc");
        const dataLSC = await collectionLSC.find({}).toArray();
        const allCandidatesLSC = dataLSC.map((doc) => doc.positions.flatMap((position) => position.candidates || [])).flat();

        const collectionLSCBoardMembers = db.collection("candidates_lsc");

        // Fetch all data from the collection
        const dataLSCBoardmembers = await collectionLSCBoardMembers.find({}).toArray();

        const allBoardMembers = dataLSC
          .map((doc) =>
            doc.positions
              .filter((position) => position.position === "Board Member")
              .flatMap((position) => position.programs)
              .flatMap((program) => {
                // Log each program before adding to the flatMap result
                // console.log("Program:", program);

                // Add program.program inside each candidate object
                program.candidates.forEach((candidate) => {
                  candidate.program = program.program; // Add program.program to each candidate
                });

                // console.log("Updated candidates:", program.candidates);

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

    // app.get("/review", async (req, res) => {
    //   res.render("voter/review");
    // });

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
              college.positions[position] = positionDoc.programs.reduce((programMap, programDoc) => {
                programMap[programDoc.program] = programDoc.candidates;
                return programMap;
              }, {});
            } else {
              // For other positions (Governor, Vice Governor), just map them normally
              college.positions[position] = positionDoc.candidates;
            }
          });
          return college;
        });

        // console.log(structuredData);

        // Fetch voter counts per college
        const votersCollection = db.collection("voters");
        const colleges = await votersCollection.find({}).toArray();
        const voterCounts = {};

        colleges.forEach((college) => {
          voterCounts[college.acronym] = {
            name: college.college,
            voters: college.voters,
          };
        });

        res.render("admin/dashboard", {
          candidates: allCandidates,
          candidates_lsc: structuredData,
          voterCounts,
        });
      } catch (error) {
        console.error("Error fetching candidates for dashboard:", error);
        res.status(500).send("Failed to fetch candidates data for the dashboard");
      }
    });

    app.post("/update-candidate", async (req, res) => {
      console.log("Form data:", req.body);
      try {
        let { _id, image, originalImage, name, party, moreInfo, candidatePosition } = req.body;

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

    app.post("/update-candidate-lsc", async (req, res) => {
      try {
        let { _id, candidatePosition, party, name, moreInfo, image, collegeAcronym, program, originalImage } = req.body;

        if (!_id || !candidatePosition || !collegeAcronym) {
          return res.status(400).json({ error: "Missing required fields." });
        }

        console.log("🔍 Debugging update-candidate-lsc:");
        console.log("Received Data:", req.body);

        if (!image || image.trim() === "") {
          image = originalImage;
        }

        // Find the college document based on the collegeAcronym
        const college = await db.collection("candidates_lsc").findOne({ collegeAcronym });

        if (!college) {
          console.log(`❌ College with acronym '${collegeAcronym}' not found.`);
          return res.status(404).json({ error: `College '${collegeAcronym}' not found.` });
        }

        console.log("✅ College Found:", college.collegeName);

        let updated = false;

        // Search for the position by name in the positions array
        console.log(`🔍 Searching position '${candidatePosition}'`);
        console.log(
          "🔍 Available Positions:",
          college.positions.map((pos) => pos.position)
        );

        let positionFound = college.positions.find((pos) => pos.position === candidatePosition);

        if (!positionFound) {
          console.log(`❌ Position '${candidatePosition}' not found.`);
          return res.status(404).json({ error: `Position '${candidatePosition}' not found.` });
        }

        console.log("✅ Position found:", positionFound);

        // Handle the Board Member position with programs
        if (candidatePosition === "Board Member" && program) {
          console.log(`🔍 Searching Board Member in program '${program}'`);

          if (positionFound.programs) {
            const programFound = positionFound.programs.find((prog) => prog.program === program);

            if (programFound) {
              console.log("✅ Program found inside Board Member.");

              // Find and update the candidate within the program
              programFound.candidates = programFound.candidates.map((candidate) => {
                if (candidate._id === _id) {
                  console.log(`✅ Match found for candidate ID: ${_id}, updating...`);
                  updated = true;
                  return { ...candidate, party, name, moreInfo, image };
                }
                return candidate;
              });
            } else {
              console.log(`❌ Program '${program}' not found in Board Member.`);
            }
          } else {
            console.log(`❌ Program data not found in Board Member.`);
          }
        } else {
          // Handle other positions (e.g., Governor, Vice Governor)
          positionFound.candidates = positionFound.candidates.map((candidate) => {
            if (candidate._id === _id) {
              console.log(`✅ Match found for candidate ID: ${_id}, updating...`);
              updated = true;
              return { ...candidate, party, name, moreInfo, image };
            }
            return candidate;
          });
        }

        if (!updated) {
          console.log(`❌ Candidate with ID '${_id}' not found.`);
          return res.status(404).json({ error: "Candidate not found." });
        }

        // Save the updated document back to the database
        await db.collection("candidates_lsc").updateOne({ collegeAcronym }, { $set: { positions: college.positions } });

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
        res.status(500).json({ error: "Internal server error", details: error.message });
      }
    });

    app.post("/add-candidate", async (req, res) => {
      try {
        let { _id, name, image, party, moreInfo, candidatePosition } = req.body;

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
        const result = await collection.updateOne({ position: candidatePosition }, { $push: { candidates: newCandidate } });

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

    app.post("/add-candidate-lsc", async (req, res) => {
      try {
        const { candidatePosition, party, name, moreInfo, image, collegeAcronym, program } = req.body;

        if (!candidatePosition || !collegeAcronym || !name || !party) {
          return res.status(400).json({ error: "Missing required fields." });
        }

        // Default image if none is provided
        const candidateImage = image && image !== "" ? image : "img/placeholder_admin_profile.png";

        // Find the college document
        const college = await db.collection("candidates_lsc").findOne({ collegeAcronym });

        if (!college) {
          return res.status(404).json({ error: `College '${collegeAcronym}' not found.` });
        }

        console.log("✅ College Found:", college.collegeName);

        let positionFound = college.positions.find((pos) => pos.position === candidatePosition);

        if (!positionFound) {
          return res.status(404).json({ error: `Position '${candidatePosition}' not found.` });
        }

        console.log("✅ Position found:", positionFound);

        let newCandidateId;
        if (candidatePosition === "Board Member" && program) {
          // Handle Board Member (check program first)
          let programFound = positionFound.programs.find((prog) => prog.program === program);

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
          const highestId = positionFound.candidates.reduce((max, candidate) => {
            const match = candidate._id.match(/_(\d+)$/);
            return match ? Math.max(max, parseInt(match[1], 10)) : max;
          }, 0);

          newCandidateId = `${candidatePosition.toLowerCase().replace(" ", "_")}_${highestId + 1}`;

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
        await db.collection("candidates_lsc").updateOne({ collegeAcronym }, { $set: { positions: college.positions } });

        console.log(`✅ New candidate '${name}' added with ID: ${newCandidateId}`);
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
          return res.status(400).json({ error: "Position and college are required." });
        }

        // Find the college document
        const collegeDoc = await db.collection("candidates_lsc").findOne({ collegeAcronym: college });

        if (!collegeDoc) {
          return res.status(404).json({ error: `College '${college}' not found.` });
        }

        console.log("✅ College Found:", collegeDoc.collegeName);

        // Find the position
        let positionFound = collegeDoc.positions.find((pos) => pos.position === position);

        if (!positionFound) {
          return res.status(404).json({ error: `Position '${position}' not found.` });
        }

        console.log("✅ Position Found:", positionFound);

        let candidates = [];

        if (position === "Board Member" && program) {
          // Handle Board Member with program filtering
          const programFound = positionFound.programs.find((prog) => prog.program === program);

          if (!programFound) {
            return res.status(404).json({ error: `Program '${program}' not found.` });
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
        const result = await collection.updateOne({ "candidates._id": _id }, { $pull: { candidates: { _id: _id } } });

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
        const college = await db.collection("candidates_lsc").findOne({ collegeAcronym });

        if (!college) {
          return res.status(404).json({ error: `College '${collegeAcronym}' not found.` });
        }

        console.log("✅ College Found:", college.collegeName);

        let positionFound = college.positions.find((pos) => pos.position === candidatePosition);

        if (!positionFound) {
          return res.status(404).json({ error: `Position '${candidatePosition}' not found.` });
        }

        console.log("✅ Position Found:", candidatePosition);

        let updated = false;

        if (candidatePosition === "Board Member" && program) {
          // Find the correct program within Board Member
          let programFound = positionFound.programs.find((prog) => prog.program === program);

          if (!programFound) {
            return res.status(404).json({ error: `Program '${program}' not found.` });
          }

          console.log("✅ Program Found:", program);

          // Remove the candidate
          const newCandidates = programFound.candidates.filter((candidate) => candidate._id !== _id);
          if (newCandidates.length !== programFound.candidates.length) {
            programFound.candidates = newCandidates;
            updated = true;
          }
        } else {
          // For Governor and Vice Governor
          const newCandidates = positionFound.candidates.filter((candidate) => candidate._id !== _id);
          if (newCandidates.length !== positionFound.candidates.length) {
            positionFound.candidates = newCandidates;
            updated = true;
          }
        }

        if (!updated) {
          return res.status(404).json({ error: "Candidate not found." });
        }

        // Update database
        await db.collection("candidates_lsc").updateOne({ collegeAcronym }, { $set: { positions: college.positions } });

        console.log(`✅ Candidate '${_id}' deleted successfully.`);
        res.redirect("/dashboard");
      } catch (error) {
        console.error("❌ Error deleting candidate:", error);
        res.status(500).json({ error: "Internal server error." });
      }
    });

    app.get("/api/lsc-candidates", async (req, res) => {
      try {
        const { college } = req.query;
        if (!college) {
          return res.status(400).json({ error: "College is required" });
        }

        const collectionLSC = db.collection("candidates_lsc");
        const data = await collectionLSC.findOne({
          collegeAcronym: college,
        });

        if (!data) {
          return res.json({ governor: [], viceGovernor: [], boardMembers: [] });
        }

        const governor = data.positions.find((pos) => pos.position === "Governor")?.candidates || [];
        const viceGovernor = data.positions.find((pos) => pos.position === "Vice Governor")?.candidates || [];
        const boardMembers = data.positions.find((pos) => pos.position === "Board Member")?.programs.flatMap((program) => program.candidates) || [];

        res.json({ governor, viceGovernor, boardMembers });
      } catch (error) {
        console.error("Error fetching LSC candidates:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });

    app.post("/review", (req, res) => {
      // Data from the logged-in account
      const voterCollege = req.user ? req.user.college : "CAFA";
      const voterProgram = req.user ? req.user.program : "Bachelor of Fine Arts Major in Visual Communication";

      const parseVote = (vote) => {
        try {
          if (!vote || vote === "Abstain" || (Array.isArray(vote) && vote.includes("Abstain"))) {
            return { id: "Abstain", name: "Abstain" }; // ✅ Prioritize abstain
          }
          if (typeof vote === "string") return JSON.parse(vote);
          return vote; // If already an object, return as is
        } catch (error) {
          console.error("Invalid JSON format:", vote, error);
          return { id: "Invalid", name: "Invalid" }; // Handle invalid JSON cases
        }
      };

      const votes = {
        president: parseVote(req.body.president),
        vicePresident: parseVote(req.body.vicePresident),
        senator: req.body.senator ? (Array.isArray(req.body.senator) ? req.body.senator.map(parseVote) : [parseVote(req.body.senator)]) : [{ id: "Abstain", name: "Abstain" }], // ✅ Ensure senator is always an array
        governor: parseVote(req.body.governor),
        viceGovernor: parseVote(req.body.viceGovernor),
        boardMember: parseVote(req.body.boardMember),
      };

      console.log("Processed Votes:", votes);

      res.render("voter/review", { votes, voterCollege, voterProgram });
    });

    // app.post("/review", (req, res) => {
    //   // Data from the logged-in account
    //   const voterCollege = req.user ? req.user.college : "CAFA";
    //   const voterProgram = req.user ? req.user.program : "Bachelor of Fine Arts Major in Visual Communication";

    //   const parseVote = (vote) => {
    //     try {
    //       // ✅ If `vote` is `"Abstain"` or empty, return Abstain object
    //       if (!vote || vote === "Abstain" || (Array.isArray(vote) && vote.length === 0)) {
    //         return { id: "Abstain", name: "Abstain" };
    //       }

    //       // ✅ If `vote` is a string, parse it as JSON
    //       if (typeof vote === "string") {
    //         return JSON.parse(vote);
    //       }

    //       return vote; // If it's already an object, return as is
    //     } catch (error) {
    //       console.error("Invalid JSON format:", vote, error);
    //       return { id: "Invalid", name: "Invalid" }; // Handle invalid JSON cases
    //     }
    //   };

    //   const votes = {
    //     president: parseVote(req.body.president),
    //     vicePresident: parseVote(req.body.vicePresident),
    //     senator: req.body.senator ? (Array.isArray(req.body.senator) ? req.body.senator.map(parseVote) : [parseVote(req.body.senator)]) : [{ id: "Abstain", name: "Abstain" }], // ✅ Ensure senator is always an array
    //     governor: parseVote(req.body.governor),
    //     viceGovernor: parseVote(req.body.viceGovernor),
    //     boardMember: parseVote(req.body.boardMember),
    //   };

    //   console.log(votes);

    //   res.render("voter/review", { votes, voterCollege, voterProgram });
    // });

    // app.get("/results", async (req, res) => {
    //   try {
    //     const positions = ["President", "Vice President", "Senator", "Governor", "Vice Governor", "Board Member"];
    //     const results = {};

    //     for (const position of positions) {
    //       const candidates = await contract.getCandidates(position);
    //       results[position] = candidates.map((c) => ({
    //         name: c.name,
    //         party: c.party,
    //         position: c.position,
    //         votes: c.votes.toString(),
    //       }));
    //     }

    //     res.render("admin/results", { results });
    //   } catch (error) {
    //     console.error("Error fetching results:", error);
    //     res.status(500).send("Failed to fetch results.");
    //   }
    // });

    app.get("/results", async (req, res) => {
      try {
        const votersCollection = db.collection("voters");
        const colleges = await votersCollection.find({}).toArray();
        const voterCounts = {};

        colleges.forEach((college) => {
          voterCounts[college.acronym] = {
            name: college.college,
            voters: college.voters,
          };
        });

        res.render("admin/results", { voterCounts });
      } catch (error) {
        console.error("Error fetching voter counts:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.post("/submit-voters", async (req, res) => {
      try {
        const { CAFA, CAL, CBEA } = req.body;
        const votersCollection = db.collection("voters");

        await votersCollection.updateOne({ acronym: "CAFA" }, { $set: { voters: parseInt(CAFA) } }, { upsert: true });
        await votersCollection.updateOne({ acronym: "CAL" }, { $set: { voters: parseInt(CAL) } }, { upsert: true });
        await votersCollection.updateOne({ acronym: "CBEA" }, { $set: { voters: parseInt(CBEA) } }, { upsert: true });

        res.sendStatus(200);
      } catch (error) {
        console.error("Error updating voter counts:", error);
        res.status(500).send("Failed to update voter counts.");
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
