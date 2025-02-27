const express = require("express");
const path = require("path");
const connectToDatabase = require("./db");
const bodyParser = require("body-parser");
const { ethers } = require("ethers");
require("dotenv").config();
const bcrypt = require("bcrypt");
const session = require("express-session");

const passport = require("passport");
const AzureOAuth2Strategy = require("passport-azure-ad-oauth2").Strategy;

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use(
  session({
    secret: process.env.SESSION_SECRET_KEY, // Use .env secret or fallback
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }, // Set to true if using HTTPS
  })
);

app.use(passport.initialize());
app.use(passport.session());

passport.use(
  new AzureOAuth2Strategy(
    {
      clientID: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      callbackURL: "http://localhost:3000/auth/microsoft/callback",
      tenant: process.env.MICROSOFT_TENANT_ID,
      resource: "https://graph.microsoft.com",
      scope: ["openid", "email", "profile", "User.Read"],
    },
    async (accessToken, refreshToken, params, profile, done) => {
      try {
        // Decode the JWT token from Microsoft
        const decodedToken = JSON.parse(Buffer.from(params.id_token.split(".")[1], "base64"));

        // Extract basic details
        const userEmail = decodedToken.email || decodedToken.preferred_username || decodedToken.upn;
        const userName = decodedToken.name;

        console.log("Decoded Token:", decodedToken); // Logs all available token details

        // Call Microsoft Graph API for additional user details
        const response = await fetch("https://graph.microsoft.com/v1.0/me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        const userProfile = await response.json();
        console.log("Microsoft Graph User Profile:", userProfile);

        const user = {
          name: userProfile.displayName || userName,
          email: userProfile.mail || userEmail,
          jobTitle: userProfile.jobTitle || "N/A",
          department: userProfile.department || "N/A",
          school: userProfile.officeLocation || "N/A",
        };

        console.log("Final User Object:", user);

        done(null, user);
      } catch (error) {
        console.error("Error fetching Microsoft user info:", error);
        done(error, null);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

let db;

const { Mutex } = require("async-mutex");

const nonceMutex = new Mutex(); // Mutex to lock nonce updates

const startServer = async () => {
  try {
    db = await connectToDatabase();
    console.log("Connected to the database successfully!");

    app.get("/auth/microsoft", passport.authenticate("azure_ad_oauth2"));

    app.get("/auth/microsoft/callback", passport.authenticate("azure_ad_oauth2", { failureRedirect: "/register" }), async (req, res) => {
      // Check registration status
      const voter = await db.collection("registered_voters").findOne({ email: req.user.email });
      if (!voter) {
        return res.redirect("/register?error=not_registered");
      }
      const redirectUrl = req.session.returnTo || "/";
      delete req.session.returnTo;
      res.redirect(redirectUrl);
    });

    function ensureAuthenticated(req, res, next) {
      if (req.isAuthenticated()) {
        return next();
      }
      // Store the original URL the user was trying to access
      req.session.returnTo = req.originalUrl;
      res.redirect("/auth/microsoft");
    }

    app.post("/register", async (req, res) => {
      try {
        const { fullName, email, studentNumber, campus, college, program } = req.body;

        if (!fullName || !email || !studentNumber || !campus || !college || !program) {
          return res.status(400).json({ error: "All fields are required" });
        }

        const voterData = {
          name: fullName,
          email: email,
          student_number: studentNumber,
          campus: campus,
          college: college,
          program: program,
          status: "Registered",
        };

        // Use upsert to update an existing record or insert a new one
        const result = await db.collection("registered_voters").updateOne({ email: email }, { $set: voterData }, { upsert: true });

        // If the document was found (matchedCount > 0), it means we're updating info.
        if (result.matchedCount > 0) {
          return res.redirect("/?status=" + encodeURIComponent("Info Updated"));
        } else {
          // New registration, so no alert
          return res.redirect("/?status=" + encodeURIComponent("Info Updated"));
        }
      } catch (error) {
        console.error("Error updating voter:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.get("/register", async (req, res) => {
      // Ensure the user is authenticated
      if (!req.user) {
        return res.redirect("/auth/microsoft");
      }

      try {
        // Retrieve the voter's record based on the authenticated user's email
        const voter = await db.collection("registered_voters").findOne({ email: req.user.email });
        res.render("voter/register", { user: req.user, voter: voter, status: req.query.status || null });
      } catch (error) {
        console.error("Error checking registration status:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.get("/admin-login", async (req, res) => {
      res.render("admin/admin-login");
    });

    app.post("/admin-login", async (req, res) => {
      try {
        const { email, password } = req.body;
        console.log("Login attempt for email:", email);

        const admin = await db.collection("admin_accounts").findOne({ email });

        if (!admin) {
          console.log("Admin not found for email:", email);
          return res.redirect("/admin-login"); // Redirect on invalid login
        }

        console.log("Admin found:", admin);

        const passwordMatch = await bcrypt.compare(password, admin.password);
        console.log("Password match:", passwordMatch);

        if (!passwordMatch) {
          console.log("Incorrect password for email:", email);
          return res.redirect("/admin-login"); // Redirect on incorrect password
        }

        // Store admin details in session
        req.session.admin = {
          id: admin._id,
          name: admin.name,
          email: admin.email,
          username: admin.username,
          role: admin.role,
          img: admin.img,
        };

        console.log("Session set for admin:", req.session.admin);

        res.redirect("/manage-accounts"); // Redirect to dashboard after login
      } catch (error) {
        console.error("Login error:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    // const voterCollege = req.user ? req.user.college : "CAL";
    // const voterProgram = req.user
    //   ? req.user.program
    //   : "Bachelor of Performing Arts";

    // Helper function to compute current period (same logic as client-side)
    // Helper function: compute current period based on electionConfig and current date
    function computeCurrentPeriod(electionConfig, now = new Date()) {
      console.log("computeCurrentPeriod: now =", now);
      if (electionConfig.electionStatus === "Temporarily Closed") {
        console.log("computeCurrentPeriod: election is temporarily closed");
        return { name: "Temporarily Closed", duration: "", timeUntil: null };
      }
      if (!electionConfig.registrationStart || !electionConfig.registrationEnd || !electionConfig.votingStart || !electionConfig.votingEnd) {
        console.log("computeCurrentPeriod: one or more date values are missing");
        return { name: "Election Not Active", duration: "Not set", timeUntil: null };
      }
      const regStart = new Date(electionConfig.registrationStart);
      const regEnd = new Date(electionConfig.registrationEnd);
      const voteStart = new Date(electionConfig.votingStart);
      const voteEnd = new Date(electionConfig.votingEnd);
      const daysUntil = (future) => Math.ceil((future - now) / (1000 * 60 * 60 * 24));

      console.log("computeCurrentPeriod: regStart =", regStart, ", regEnd =", regEnd);
      console.log("computeCurrentPeriod: voteStart =", voteStart, ", voteEnd =", voteEnd);

      if (now < regStart) {
        return {
          name: "Waiting for Registration Period",
          duration: regStart.toLocaleString() + " - " + regEnd.toLocaleString(),
          timeUntil: daysUntil(regStart) + " days until registration",
        };
      } else if (now >= regStart && now <= regEnd) {
        return {
          name: "Registration Period",
          duration: regStart.toLocaleString() + " - " + regEnd.toLocaleString(),
          timeUntil: null,
        };
      } else if (now > regEnd && now < voteStart) {
        return {
          name: "Waiting for Voting Period",
          duration: voteStart.toLocaleString() + " - " + voteEnd.toLocaleString(),
          timeUntil: daysUntil(voteStart) + " days until voting",
        };
      } else if (now >= voteStart && now <= voteEnd) {
        return {
          name: "Voting Period",
          duration: voteStart.toLocaleString() + " - " + voteEnd.toLocaleString(),
          timeUntil: null,
        };
      } else if (now > voteEnd) {
        if (electionConfig.electionStatus === "Results Are Out") {
          return { name: "Results Are Out Period", duration: "", timeUntil: null };
        } else {
          return { name: "Results Double Checking Period", duration: "", timeUntil: "Awaiting manual trigger" };
        }
      }
      return { name: "Unknown Phase", duration: "N/A", timeUntil: null };
    }

    function getHomepageView(periodName) {
      console.log("getHomepageView: periodName =", periodName);
      switch (periodName) {
        case "Waiting for Registration Period":
        case "Registration Period":
          return "homepages/index-registration-period";
        case "Waiting for Voting Period":
        case "Voting Period":
          return "homepages/index-voting-period";
        case "Results Double Checking Period":
          return "homepages/index-vote-checking-period";
        case "Results Are Out Period":
          return "homepages/index-results-are-out-period";
        case "Temporarily Closed":
          return "homepages/index-system-temporarily-closed";
        default:
          return "homepages/index-election-not-active";
      }
    }

    // New dynamic index route: render homepage based on current period.
    app.get("/", async (req, res) => {
      // Retrieve the configuration or use defaults
      let electionConfig = (await db.collection("election_config").findOne({})) || {
        electionName: "",
        registrationStart: "",
        registrationEnd: "",
        votingStart: "",
        votingEnd: "",
        partylists: [],
        listOfElections: [],
        fakeCurrentDate: null,
        currentPeriod: { name: "Election Not Active", duration: "", nextPeriod: { name: "", remainingDays: 0 } },
      };

      console.log("Dynamic Index Route: Raw electionConfig from DB:", electionConfig);

      // Use the fake current date if available; otherwise, use the actual current date.
      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      console.log("Dynamic Index Route: Using current date =", now);

      // Compute the current phase based on the dates and current/fake date
      const currentPeriod = computeCurrentPeriod(electionConfig, now);
      console.log("Dynamic Index Route: Computed current period =", currentPeriod);

      // Update the election configuration object to reflect the computed period
      electionConfig.currentPeriod = currentPeriod;

      // Determine the homepage view based on the computed current period name
      const homepageView = getHomepageView(currentPeriod.name);
      console.log("Dynamic Index Route: Rendering view =", homepageView);

      // Render the view with the updated configuration and current date
      res.render(homepageView, { electionConfig, currentDate: now.toISOString() });
    });

    // app.get("/", (req, res) => {
    //   res.sendFile(path.join(__dirname, "public", "index.ht  ml"));
    // });

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
          voterHashes: c.voterHashes || [], // Assuming `voterHashes` is an array in your contract
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
      try {
        const { votes, voterHash } = req.body;

        if (!voterHash || typeof voterHash !== "string") {
          console.log("❌ Invalid voterHash received:", voterHash);
          return res.status(400).json({ error: "Invalid voter hash!" });
        }

        console.log("📡 Received Hashed Voter Hash:", voterHash);

        // Proceed with blockchain submission:
        let nonce = await provider.getTransactionCount(wallet.address, "pending");
        console.log("📡 Current nonce:", nonce);

        const positions = Object.keys(votes);
        const batchVotes = [];

        for (const position of positions) {
          const formattedPosition = formatPosition(position);
          const voteData = votes[position];

          if (Array.isArray(voteData)) {
            for (const candidate of voteData) {
              const index = await findCandidateIndex(formattedPosition, candidate.name);
              if (index === -1) continue;
              batchVotes.push({ position: formattedPosition, index });
            }
          } else {
            const index = await findCandidateIndex(formattedPosition, voteData.name);
            if (index === -1) continue;
            batchVotes.push({ position: formattedPosition, index });
          }
        }

        if (batchVotes.length === 0) {
          return res.status(400).json({ error: "No valid votes to submit." });
        }

        console.log("✅ Final batchVotes array:", JSON.stringify(batchVotes, null, 2));

        const positionsArray = batchVotes.map((vote) => vote.position);
        const indicesArray = batchVotes.map((vote) => vote.index);

        console.log("📡 Submitting transaction...");
        const tx = await contract.connect(wallet).batchVote(positionsArray, indicesArray, voterHash, { nonce });
        console.log("📡 Transaction submitted! Hash:", tx.hash);
        await tx.wait();
        console.log("✅ Transaction confirmed!");

        // After confirmation, redirect to /verify:
        // After transaction is confirmed:
        res.status(200).json({
          message: "Votes successfully submitted to blockchain!",
          transactionHash: tx.hash,
          redirect: "/verify",
        });
      } catch (error) {
        console.error("❌ Error submitting votes:", error);
        res.status(500).json({ error: "Failed to submit votes." });
      }
    });

    // app.get("/vote-status", async (req, res) => {
    //   const { voterHash } = req.query;

    //   const vote = await db.collection("vote_queue").findOne({ voterHash });

    //   if (!vote) {
    //     return res.status(404).json({ status: "not found" });
    //   }

    //   res.json({
    //     status: vote.status, // Can be 'pending', 'completed', or 'failed'
    //     transactionHash: vote.transactionHash || null,
    //     queuePosition: voteQueue.size + 1, // Show queue position
    //   });
    // });

    // app.get("/get-queue-position", (req, res) => {
    //   res.json({ position: voteQueue.size + 1 });
    // });

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

        const statusCollection = db.collection("system_status");

        // **Reset status in MongoDB**
        await statusCollection.updateOne({ _id: "candidate_submission" }, { $set: { submitted: false } }, { upsert: true });
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

        const statusCollection = db.collection("system_status");

        // **Update status in MongoDB**
        await statusCollection.updateOne({ _id: "candidate_submission" }, { $set: { submitted: true } }, { upsert: true });

        res.json({ message: "Candidates successfully submitted to blockchain!" });
      } catch (error) {
        console.error("❌ ERROR submitting candidates:", error);
        res.status(500).json({ error: "Failed to submit candidates." });
      }
    });

    const JSZip = require("jszip");
    const { ObjectId } = require("mongodb");

    app.get("/api/export-archive/:id", async (req, res) => {
      try {
        const archiveId = req.params.id;
        const archive = await db.collection("election_archive").findOne({ _id: new ObjectId(archiveId) });

        if (!archive) {
          return res.status(404).json({ message: "Archive not found" });
        }

        // Create a new zip archive
        const zip = new JSZip();
        // Add two separate JSON files to the zip
        zip.file("candidates.json", JSON.stringify(archive.candidates, null, 2));
        zip.file("candidatesLsc.json", JSON.stringify(archive.candidatesLsc, null, 2));

        // Generate the zip file as a node buffer
        const zipContent = await zip.generateAsync({ type: "nodebuffer" });
        // Set response headers to download the zip file
        res.setHeader("Content-Disposition", `attachment; filename=archive-${archiveId}.zip`);
        res.setHeader("Content-Type", "application/zip");
        res.send(zipContent);
      } catch (error) {
        res.status(500).json({ message: "Error exporting archive", error: error.message });
      }
    });

    // ==========================
    // BACKEND SETUP (EXPRESS)
    // ==========================

    app.get("/vote", ensureAuthenticated, async (req, res) => {
      try {
        // Check if the logged-in user's email exists in the registered_voters collection.
        const registeredVoter = await db.collection("registered_voters").findOne({ email: req.user.email });
        if (!registeredVoter) {
          // If not registered, redirect to the registration page with an error.
          return res.redirect("/register?error=not_registered");
        }

        // Now, get the voter's college and program from the registered_voters entry.
        const voterCollege = registeredVoter.college;
        const voterProgram = registeredVoter.program;
        const collegeAcronym = voterCollege.match(/\(([^)]+)\)/);

        // Fetch SSC candidates.
        const collection = db.collection("candidates");
        const data = await collection.find({}).toArray();
        const allCandidates = data.map((doc) => doc.candidates).flat();

        // Fetch LSC candidates.
        const collectionLSC = db.collection("candidates_lsc");
        const dataLSC = await collectionLSC.find({}).toArray();
        const allCandidatesLSC = dataLSC.map((doc) => doc.positions.flatMap((position) => position.candidates || [])).flat();

        // Fetch LSC Board Members.
        const allBoardMembers = dataLSC
          .map((doc) =>
            doc.positions
              .filter((position) => position.position === "Board Member")
              .flatMap((position) => position.programs)
              .flatMap((program) => {
                // Add program.program inside each candidate object.
                program.candidates.forEach((candidate) => {
                  candidate.program = program.program;
                });
                return program.candidates;
              })
          )
          .flat();

        // Render the vote page with the fetched candidate data and the registered voter's college and program.
        res.render("voter/vote", {
          candidates: allCandidates,
          candidates_lsc: allCandidatesLSC,
          lsc_board_members: allBoardMembers,
          voterProgram,
          voterCollege: collegeAcronym[1],
        });
      } catch (error) {
        console.error("Error fetching candidates:", error);
        res.status(500).send("Failed to fetch candidates");
      }
    });

    app.get("/review", async (req, res) => {
      res.render("voter/review");
    });

    app.get("/candidates", async (req, res) => {
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

        res.render("admin/candidates", {
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

      const voterHash = "123";
      console.log(voterHash);

      const parseVote = (vote) => {
        try {
          if (!vote || vote === "Abstain" || (Array.isArray(vote) && vote.includes("Abstain"))) {
            return { id: "Abstain", name: "Abstain", image: "", party: "", position: "", moreInfo: "" }; // ✅ Keep the format consistent
          }
          if (typeof vote === "string") return JSON.parse(vote);
          return vote; // If already an object, return as is
        } catch (error) {
          console.error("Invalid JSON format:", vote, error);
          return { id: "Invalid", name: "Invalid", image: "", party: "", position: "", moreInfo: "" }; // Handle invalid JSON cases
        }
      };

      const votes = {
        president: parseVote(req.body.president),
        vicePresident: parseVote(req.body.vicePresident),
        senator: req.body.senator ? (Array.isArray(req.body.senator) ? req.body.senator.map(parseVote) : [parseVote(req.body.senator)]) : [{ id: "Abstain", name: "Abstain", image: "", party: "", position: "", moreInfo: "" }], // ✅ Ensure senator is always an array
        governor: parseVote(req.body.governor),
        viceGovernor: parseVote(req.body.viceGovernor),
        boardMember: parseVote(req.body.boardMember),
      };

      console.log("Processed Votes:", votes);

      res.render("voter/review", { votes, voterCollege, voterProgram, voterHash });
    });

    // Helper to calculate the current period based on configuration and current date
    function calculateCurrentPeriod(config, now) {
      if (!config.registrationStart || !config.registrationEnd || !config.votingStart || !config.votingEnd) {
        return { name: "Election Not Active", duration: "Configuration Incomplete", waitingFor: null };
      }
      const regStart = new Date(config.registrationStart);
      const regEnd = new Date(config.registrationEnd);
      const voteStart = new Date(config.votingStart);
      const voteEnd = new Date(config.votingEnd);
      if (now < regStart) {
        return { name: "Waiting for Registration Period", duration: `${now.toLocaleString()} to ${regStart.toLocaleString()}`, waitingFor: "Registration" };
      } else if (now >= regStart && now <= regEnd) {
        return { name: "Registration Period", duration: `${regStart.toLocaleString()} to ${regEnd.toLocaleString()}` };
      } else if (now > regEnd && now < voteStart) {
        return { name: "Waiting for Voting Period", duration: `${regEnd.toLocaleString()} to ${voteStart.toLocaleString()}`, waitingFor: "Voting" };
      } else if (now >= voteStart && now <= voteEnd) {
        return { name: "Voting Period", duration: `${voteStart.toLocaleString()} to ${voteEnd.toLocaleString()}` };
      } else if (now > voteEnd) {
        if (config.electionStatus === "Results Are Out") {
          return { name: "Results Are Out Period", duration: `${voteEnd.toLocaleString()} to (manual)` };
        } else {
          return { name: "Results Double Checking Period", duration: `${voteEnd.toLocaleString()} to (manual trigger)` };
        }
      }
      return { name: "Election Not Active", duration: "N/A" };
    }

    // GET /configuration
    app.get("/configuration", async (req, res) => {
      let electionConfig = (await db.collection("election_config").findOne({})) || {
        electionName: "",
        registrationStart: "",
        registrationEnd: "",
        votingStart: "",
        votingEnd: "",
        partylists: [],
        colleges: {},
        fakeCurrentDate: null,
        electionStatus: "Election Not Active",
        currentPeriod: { name: "Election Not Active", duration: "", waitingFor: null },
      };
      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);
      const simulatedDate = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate).toISOString() : null;
      res.render("admin/configuration", { electionConfig, simulatedDate });
    });

    app.post("/configuration", async (req, res) => {
      try {
        const { electionName, registrationStart, registrationEnd, votingStart, votingEnd, partylists, colleges } = req.body;
        const partylistsArray = partylists ? partylists.split(",").map((item) => item.trim()) : [];

        // Define mapping for college acronym to full name.
        const collegeMapping = {
          CAFA: "College of Architecture and Fine Arts",
          CAL: "College of Arts and Letters",
          CBEA: "College of Business Education and Accountancy",
          CCJE: "College of Criminal Justice Education",
          COE: "College of Engineering",
          COED: "College of Education",
          CHTM: "College of Hospitality and Tourism Management",
          CIT: "College of Industrial Technology",
          CICT: "College of Information and Communications Technology",
          CON: "College of Nursing",
          CS: "College of Science",
          CSSP: "College of Social Sciences and Philosophy",
          CSER: "College of Sports, Exercise, and Recreation",
        };

        // Merge the colleges into a single list.
        let totalStudents = 0;
        let mergedList = [];
        if (colleges) {
          for (const acronym in colleges) {
            const voters = parseInt(colleges[acronym], 10) || 0;
            totalStudents += voters;
            mergedList.push({
              acronym: acronym,
              name: collegeMapping[acronym] || acronym, // fallback to acronym if mapping not found
              voters: voters,
            });
          }
        }

        const update = {
          electionName,
          registrationStart: registrationStart ? new Date(registrationStart) : null,
          registrationEnd: registrationEnd ? new Date(registrationEnd) : null,
          votingStart: votingStart ? new Date(votingStart) : null,
          votingEnd: votingEnd ? new Date(votingEnd) : null,
          partylists: partylistsArray,
          // Store only the merged list in listOfElections.
          listOfElections: mergedList,
          totalStudents,
          // Default electionStatus and currentPeriod can be computed on GET based on dates.
          electionStatus: "Registration Period",
          currentPeriod: { name: "Registration Period", duration: "", waitingFor: null },
          updatedAt: new Date(),
        };

        await db.collection("election_config").updateOne({}, { $set: update, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
        const savedConfig = await db.collection("election_config").findOne({});
        console.log("Saved Configuration:", savedConfig);
        res.redirect("configuration");
      } catch (error) {
        console.error("Error updating configuration:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    // POST /set-test-date (update fake current date and current phase)
    app.post("/set-test-date", async (req, res) => {
      try {
        const { fakeCurrentDate, period } = req.body;
        await db.collection("election_config").updateOne({}, { $set: { fakeCurrentDate, currentPeriod: period, updatedAt: new Date() } }, { upsert: true });
        res.json({ success: true, fakeCurrentDate, period });
      } catch (error) {
        console.error("Error setting fake current date:", error);
        res.status(500).json({ success: false });
      }
    });

    // POST /temporarily-closed
    app.post("/temporarily-closed", async (req, res) => {
      try {
        const update = {
          electionStatus: "Temporarily Closed",
          currentPeriod: { name: "Temporarily Closed", duration: "", waitingFor: null },
          updatedAt: new Date(),
        };
        await db.collection("election_config").updateOne({}, { $set: update });
        res.redirect("/dashboard");
      } catch (error) {
        console.error("Error setting temporarily closed:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    // POST /resume-election
    app.post("/resume-election", async (req, res) => {
      try {
        // When resuming, you may want to recalc the current phase based on dates.
        const config = await db.collection("election_config").findOne({});
        const now = config.fakeCurrentDate ? new Date(config.fakeCurrentDate) : new Date();
        const currentPeriod = calculateCurrentPeriod(config, now);
        const update = {
          electionStatus: currentPeriod.name, // e.g. "Registration Period" or as computed
          currentPeriod,
          updatedAt: new Date(),
        };
        await db.collection("election_config").updateOne({}, { $set: update });
        res.redirect("/configuration");
      } catch (error) {
        console.error("Error resuming election:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    // POST /set-results-out
    app.post("/set-results-out", async (req, res) => {
      try {
        const update = {
          electionStatus: "Results Are Out",
          currentPeriod: { name: "Results Are Out Period", duration: "", waitingFor: null },
          updatedAt: new Date(),
        };
        await db.collection("election_config").updateOne({}, { $set: update });
        res.redirect("/configuration");
      } catch (error) {
        console.error("Error setting results out:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.post("/api/reset-election", async (req, res) => {
      try {
        console.log("Reset election initiated.");

        // Check if candidates have been submitted
        console.log("Checking candidate submission status...");
        const submissionStatus = await db.collection("system_status").findOne({ _id: "candidate_submission" });
        console.log("Submission status retrieved:", submissionStatus);

        if (submissionStatus && submissionStatus.submitted === true) {
          console.log("Candidates have been submitted. Archiving candidate data...");

          // Archive candidates data from "candidates" and "candidates_lsc"
          const candidatesData = await db.collection("candidates").find({}).toArray();
          console.log("Candidates data count:", candidatesData.length);
          const candidatesLscData = await db.collection("candidates_lsc").find({}).toArray();
          console.log("Candidates LSC data count:", candidatesLscData.length);

          const archiveResult = await db.collection("election_archive").insertOne({
            electionName: "", // Customize as needed
            registrationStart: "", // If applicable
            registrationEnd: "",
            votingStart: "",
            votingEnd: "",
            electionStatus: "Candidates Submitted",
            archivedAt: new Date(),
            candidates: candidatesData,
            candidatesLsc: candidatesLscData,
          });
          console.log("Candidate data archived. Archive ID:", archiveResult.insertedId);

          // Trigger reset-candidates (e.g., call your blockchain function)
          console.log("Triggering contract.resetCandidates()...");
          const tx = await contract.resetCandidates();
          await tx.wait();
          console.log("Blockchain candidate reset confirmed.");

          // Update the submission status to false
          console.log("Updating candidate submission status in the database to false...");
          // await db.collection("system_status").updateOne({ _id: "candidate_submission" }, { $set: { submitted: false } });
          console.log("Candidate submission status updated to false.");
        } else {
          console.log("Candidate submission status is not true. Skipping candidate archiving and blockchain reset.");
        }

        // Original election configuration reset logic (DO NOT OMIT ANYTHING)
        console.log("Resetting election configuration...");
        await db.collection("election_config").deleteMany({});
        await db.collection("election_config").insertOne({
          electionName: "",
          registrationPeriod: { start: "", end: "" },
          votingPeriod: { start: "", end: "" },
          totalElections: 14,
          totalPartylists: 0,
          partylists: [],
          totalCandidates: 0,
          phase: "Election Inactive",
          listOfElections: [
            { name: "Supreme Student Council (SSC) - BulSU Main", voters: 0 },
            { name: "College of Architecture and Fine Arts (CAFA)", voters: 0 },
            { name: "College of Arts and Letters (CAL)", voters: 0 },
            { name: "College of Business Education and Accountancy (CBEA)", voters: 0 },
            { name: "College of Criminal Justice Education (CCJE)", voters: 0 },
            { name: "College of Engineering (COE)", voters: 0 },
            { name: "College of Education (COED)", voters: 0 },
            { name: "College of Hospitality and Tourism Management (CHTM)", voters: 0 },
            { name: "College of Industrial Technology (CIT)", voters: 0 },
            { name: "College of Information and Communications Technology (CICT)", voters: 0 },
            { name: "College of Nursing (CON)", voters: 0 },
            { name: "College of Science (CS)", voters: 0 },
            { name: "College of Social Sciences and Philosophy (CSSP)", voters: 0 },
            { name: "College of Sports, Exercise, and Recreation (CSER)", voters: 0 },
          ],
        });
        console.log("Election configuration reset complete.");

        res.redirect("configuration");
      } catch (error) {
        console.error("Error resetting election:", error);
        res.status(500).json({ message: "Error resetting election", error: error.message });
      }
    });

    // GET route for the election archive page
    app.get("/archives", async (req, res) => {
      try {
        const archives = await db.collection("election_archive").find({}).toArray();
        res.render("admin/archives", { archives });
      } catch (error) {
        console.error("Error fetching archives:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    const getElectionPhase = (registrationPeriod, votingPeriod, currentDate) => {
      console.log("🟢 Checking Election Phase...");
      console.log("📅 Current Date:", currentDate);
      console.log("📌 Registration Start:", registrationPeriod.start);
      console.log("📌 Registration End:", registrationPeriod.end);
      console.log("📌 Voting Start:", votingPeriod.start);
      console.log("📌 Voting End:", votingPeriod.end);

      if (!registrationPeriod.start || !votingPeriod.start) {
        console.log("❌ No registration/voting period found. Setting phase to 'Election Inactive'.");
        return "Election Inactive";
      }

      const regStart = new Date(registrationPeriod.start);
      const regEnd = new Date(registrationPeriod.end);
      const voteStart = new Date(votingPeriod.start);
      const voteEnd = new Date(votingPeriod.end);

      let phase = "Election Inactive";

      if (currentDate < regStart) {
        console.log("✅ Election is Active, but registration hasn't started yet.");
        phase = "Election Active";
      } else if (currentDate >= regStart && currentDate <= regEnd) {
        console.log("🟡 Registration phase is ongoing.");
        phase = "Election Active | Registration Phase";
      } else if (currentDate > regEnd && currentDate < voteStart) {
        console.log("🔵 Registration ended. Waiting for voting to begin.");
        phase = "Election Active | Waiting for Voting";
      } else if (currentDate >= voteStart && currentDate <= voteEnd) {
        console.log("🟢 Voting phase is ongoing.");
        phase = "Election Active | Voting Phase";
      } else {
        console.log("🟠 Voting period ended. Entering vote checking period.");
        phase = "Vote Checking Period";
      }

      console.log("🟣 Final Computed Phase:", phase);
      return phase;
    };

    // Modify the `/api/create-election` API:
    app.post("/api/create-election", async (req, res) => {
      try {
        console.log("🟢 Received request to create election:", req.body);

        const { electionName, registrationStart, registrationEnd, votingStart, votingEnd } = req.body;

        if (!electionName || !registrationStart || !registrationEnd || !votingStart || !votingEnd) {
          console.log("❌ Missing required fields.");
          return res.status(400).json({ message: "Missing required fields." });
        }

        const currentDate = getCurrentDate();
        console.log("📌 Current Date for Phase Calculation:", currentDate);

        const phase = getElectionPhase({ start: registrationStart, end: registrationEnd }, { start: votingStart, end: votingEnd }, currentDate);

        console.log("🟠 Computed Phase:", phase);

        const electionConfig = {
          electionName,
          registrationPeriod: { start: registrationStart, end: registrationEnd },
          votingPeriod: { start: votingStart, end: votingEnd },
          phase,
        };

        const result = await db.collection("election_config").updateOne({}, { $set: electionConfig }, { upsert: true });

        console.log("✅ Election created/updated in DB:", result);
        res.json({ message: "Election created/updated successfully!" });
      } catch (error) {
        console.error("❌ Error creating election:", error);
        res.status(500).json({ message: "Error creating election", error: error.message });
      }
    });

    // Modify the `/api/update-election` API:
    app.post("/api/update-election", async (req, res) => {
      try {
        const { electionId, ...updatedFields } = req.body;

        if (!electionId) return res.status(400).json({ message: "Election ID is missing" });

        let objectId;
        try {
          objectId = new ObjectId(electionId);
        } catch (error) {
          return res.status(400).json({ message: "Invalid Election ID format" });
        }

        const existingElection = await db.collection("election_config").findOne({ _id: objectId });

        if (!existingElection) return res.status(404).json({ message: "Election not found" });

        const currentDate = new Date(); // Change to a frontend-input date for testing

        updatedFields.phase = getElectionPhase(updatedFields.registrationPeriod || existingElection.registrationPeriod, updatedFields.votingPeriod || existingElection.votingPeriod, currentDate);

        const result = await db.collection("election_config").updateOne({ _id: objectId }, { $set: updatedFields });

        res.json({ message: "Election updated successfully!" });
      } catch (error) {
        res.status(500).json({ message: "Error updating election", error: error.message });
      }
    });

    // API to reset the election

    app.post("/api/confirm-results", async (req, res) => {
      try {
        const result = await db.collection("election_config").updateOne({}, { $set: { phase: "Results Are Out" } });

        if (result.modifiedCount === 0) {
          return res.status(500).json({ message: "Update failed, no modifications made." });
        }

        console.log("🟢 Election phase updated to 'Results Are Out'");
        res.json({ message: "Election phase updated to 'Results Are Out'!" });
      } catch (error) {
        console.error("❌ Error updating election phase:", error);
        res.status(500).json({ message: "Error updating election phase", error: error.message });
      }
    });

    let simulatedDate = null; // Store simulated date globally

    app.post("/api/update-simulated-date", async (req, res) => {
      try {
        simulatedDate = req.body.simulatedDate ? new Date(req.body.simulatedDate) : null;
        console.log("🟢 Simulated Date Updated:", simulatedDate ? simulatedDate.toISOString() : "Using Real Date");

        // Fetch current election data
        const electionConfig = await db.collection("election_config").findOne({});
        if (!electionConfig) {
          return res.status(404).json({ message: "No election found" });
        }

        // Recalculate election phase using the new simulated date
        const newPhase = getElectionPhase(electionConfig.registrationPeriod, electionConfig.votingPeriod, simulatedDate || new Date());

        // Update election phase in database
        await db.collection("election_config").updateOne({}, { $set: { phase: newPhase } });

        console.log("🔄 Phase Recalculated After Simulated Date Change:", newPhase);
        res.json({ message: "Simulated date updated and phase recalculated." });
      } catch (error) {
        console.error("❌ Error updating simulated date:", error);
        res.status(500).json({ message: "Error updating simulated date", error: error.message });
      }
    });

    // Function to get the current date (real or simulated)
    const getCurrentDate = () => {
      const currentDate = simulatedDate ? simulatedDate : new Date();
      console.log("📌 Using Date for Calculations:", currentDate);
      return currentDate;
    };

    app.get("/vote-tally", async (req, res) => {
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

        res.render("admin/election-results", { voterCounts });
      } catch (error) {
        console.error("Error fetching voter counts:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.get("/dashboard", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});
      if (!electionConfig) {
        electionConfig = {
          electionName: "",
          registrationStart: "",
          registrationEnd: "",
          votingStart: "",
          votingEnd: "",
          partylists: [],
          colleges: {},
          fakeCurrentDate: null,
          electionStatus: "Election Not Active",
          currentPeriod: { name: "Election Not Active", duration: "", waitingFor: null },
        };
      }
      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);
      console.log(electionConfig);
      res.render("admin/dashboard", { electionConfig });
    });

    app.get("/blockchain-management", async (req, res) => {
      res.render("admin/blockchain-management");
    });
    app.get("/blockchain-activity-log", async (req, res) => {
      res.render("admin/blockchain-activity-log");
    });

    app.get("/voter-info", async (req, res) => {
      try {
        const voters = await db.collection("registered_voters").find().toArray();
        res.render("admin/election-voter-info", { voters }); // Pass voters to EJS template
      } catch (error) {
        console.error("Error fetching registered voters:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.get("/voter-turnout", async (req, res) => {
      res.render("admin/election-voter-turnout");
    });
    app.get("/reset", async (req, res) => {
      res.render("admin/election-reset");
    });

    app.get("/archives", async (req, res) => {
      res.render("admin/archives");
    });

    app.get("/edit-account", async (req, res) => {
      res.render("admin/system-edit-account");
    });
    // app.get("/manage-account", async (req, res) => {
    //   res.render("admin/system-manage-accounts");
    // });
    app.get("/manage-accounts", async (req, res) => {
      try {
        console.log("Accessing /manage-accounts");
        console.log("Session data:", req.session.admin);

        if (!req.session.admin) {
          console.log("No admin session found. Redirecting to login.");
          return res.redirect("/admin-login"); // Redirect if not logged in
        }

        if (req.session.admin.role !== "admin" && req.session.admin.role !== "superadmin") {
          console.log("Unauthorized access attempt by:", req.session.admin.email);
          return res.redirect("/admin-login"); // Redirect non-admins to login
        }

        const admins = await db.collection("admin_accounts").find().toArray();
        console.log("Fetched admins:", admins.length);

        res.render("admin/system-manage-accounts", {
          admins,
          admin: req.session.admin,
          userRole: req.session.admin.role,
        });
      } catch (error) {
        console.error("Error fetching admin accounts:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    // Add New Admin (Base64 Image)
    app.post("/admin-accounts/add", async (req, res) => {
      try {
        const { name, username, password, role, imgBase64 } = req.body;

        if (role !== "admin") {
          return res.status(403).json({ error: "Only Admins can be created" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const newAdmin = {
          name,
          username,
          password: hashedPassword,
          role,
          img: imgBase64, // Store base64 image directly
        };

        await db.collection("admin_accounts").insertOne(newAdmin);
        res.redirect("/admin-accounts");
      } catch (error) {
        console.error("Error adding admin:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    // Delete Admin
    app.post("/admin-accounts/delete/:id", async (req, res) => {
      try {
        const adminId = req.params.id;
        await db.collection("admin_accounts").deleteOne({ _id: new ObjectId(adminId) });
        res.redirect("/admin-accounts");
      } catch (error) {
        console.error("Error deleting admin:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.get("/help-page", async (req, res) => {
      res.render("admin/system-help-page");
    });
    app.get("/activity-log", async (req, res) => {
      res.render("admin/system-activity-log");
    });

    app.post("/register", async (req, res) => {
      try {
        const { fullName, email, studentNumber, campus, college, program } = req.body;

        if (!fullName || !email || !studentNumber || !campus || !college || !program) {
          return res.status(400).json({ error: "All fields are required" });
        }

        const newVoter = {
          name: fullName,
          email: email,
          student_number: studentNumber,
          campus: campus,
          college: college,
          program: program,
          status: "Registered",
        };

        await db.collection("registered_voters").insertOne(newVoter);

        res.redirect("/register"); // Redirect to voter info page
      } catch (error) {
        console.error("Error registering voter:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.get("/register", (req, res) => {
      res.render("voter/register", { user: req.user || null }); // Pass user info if logged in
    });

    app.get("/admin-login", async (req, res) => {
      res.render("admin/admin-login");
    });

    app.post("/admin-login", async (req, res) => {
      try {
        const { email, password } = req.body;
        console.log("Login attempt for email:", email);

        const admin = await db.collection("admin_accounts").findOne({ email });

        if (!admin) {
          console.log("Admin not found for email:", email);
          return res.redirect("/admin-login"); // Redirect on invalid login
        }

        console.log("Admin found:", admin);

        const passwordMatch = await bcrypt.compare(password, admin.password);
        console.log("Password match:", passwordMatch);

        if (!passwordMatch) {
          console.log("Incorrect password for email:", email);
          return res.redirect("/admin-login"); // Redirect on incorrect password
        }

        // Store admin details in session
        req.session.admin = {
          id: admin._id,
          name: admin.name,
          email: admin.email,
          username: admin.username,
          role: admin.role,
          img: admin.img,
        };

        console.log("Session set for admin:", req.session.admin);

        res.redirect("/manage-accounts"); // Redirect to dashboard after login
      } catch (error) {
        console.error("Login error:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.get("/logout", (req, res) => {
      req.session.destroy((err) => {
        if (err) {
          return res.status(500).send("Error logging out");
        }
        res.redirect("/admin-login");
      });
    });

    app.get("/api/programs", async (req, res) => {
      try {
        const collegeName = req.query.college;
        if (!collegeName) return res.status(400).json({ error: "College is required" });

        const college = await db.collection("colleges").findOne({ college: collegeName });

        if (!college) return res.status(404).json({ error: "College not found" });

        res.json({ programs: college.programs });
      } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
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

// async function processVotes() {
//   console.log("🔄 Processing pending votes...");

//   // Fetch pending votes from MongoDB
//   const pendingVotes = await db.collection("vote_queue").find({ status: "pending" }).toArray();

//   for (const vote of pendingVotes) {
//     try {
//       console.log("📡 Submitting vote for:", vote.voterHash);

//       // Extract positions and indices
//       const positionsArray = Object.keys(vote.votes);
//       const indicesArray = positionsArray.map((position) => vote.votes[position]);

//       // Submit vote to blockchain
//       const tx = await contract.connect(wallet).batchVote(positionsArray, indicesArray, vote.voterHash);

//       console.log("✅ Vote submitted! Transaction Hash:", tx.hash);

//       // ✅ Update database to mark vote as completed
//       await db.collection("vote_queue").updateOne({ _id: vote._id }, { $set: { status: "completed", transactionHash: tx.hash } });
//     } catch (error) {
//       console.error("❌ Error submitting vote:", error);

//       // ✅ Mark the vote as failed if there's an error
//       await db.collection("vote_queue").updateOne({ _id: vote._id }, { $set: { status: "failed", error: error.message } });
//     }
//   }
// }
// Run processVotes every 10 seconds
// setInterval(processVotes, 10000);
