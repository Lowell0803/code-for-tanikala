const express = require("express");
const path = require("path");
const connectToDatabase = require("./db");
require("dotenv").config();
const session = require("express-session");

// function toBytes32(str) {
//   if (!str) return ethers.toUtf8Bytes("");
//   return ethers.toUtf8Bytes(str.substring(0, 32).padEnd(32, "\0"));
// }

function toBytes32(str) {
  if (!str) return ethers.encodeBytes32String("");
  return ethers.encodeBytes32String(str.slice(0, 31));
}

function fromBytes32(hexStr) {
  try {
    return ethers.decodeBytes32String(hexStr);
  } catch (error) {
    let bytes = ethers.arrayify(hexStr);
    if (bytes[bytes.length - 1] !== 0) {
      bytes[bytes.length - 1] = 0;
    }
    return ethers.toUtf8String(bytes);
  }
}

const fs = require("fs");
const solc = require("solc");

const passport = require("passport");
const AzureOAuth2Strategy = require("passport-azure-ad-oauth2").Strategy;

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

console.log();
const MongoStore = require("connect-mongo");

app.use(
  session({
    secret: process.env.SESSION_SECRET_KEY || "your_secret_key",
    resave: false,
    saveUninitialized: true,
    store: MongoStore.create({
      mongoUrl: process.env.MONGODB_URI, // Use your MongoDB connection string
      collectionName: "sessions", // Store sessions in this collection
      ttl: 24 * 60 * 60, // Session expiration time (24 hours)
    }),
    cookie: {
      secure: false, // Set to true only when using HTTPS
      maxAge: 24 * 60 * 60 * 1000, // Keep session for 24 hours
    },
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

        // console.log("Decoded Token:", decodedToken); // Logs all available token details

        // Call Microsoft Graph API for additional user details
        const response = await fetch("https://graph.microsoft.com/v1.0/me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        const userProfile = await response.json();
        // console.log("Microsoft Graph User Profile:", userProfile);

        const user = {
          name: userProfile.displayName || userName,
          email: userProfile.mail || userEmail,
          jobTitle: userProfile.jobTitle || "N/A",
          department: userProfile.department || "N/A",
          school: userProfile.officeLocation || "N/A",
        };

        // console.log("Final User Object:", user);

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

const { MongoClient } = require("mongodb");

const startServer = async () => {
  try {
    db = await connectToDatabase();

    const { ObjectId } = require("mongodb");

    // ==================================================================================================
    //                                  BLOCKCHAIN (HARDHAT)
    // ==================================================================================================

    const { ethers } = require("ethers");
    const crypto = require("crypto");

    // Set up ethers provider and wallet using environment variables
    const provider = new ethers.JsonRpcProvider(process.env.HARDHAT_RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const contractABI = require("./artifacts/contracts/AdminCandidates.sol/AdminCandidates.json").abi;
    const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, contractABI, wallet);

    // Updated: Generate a 32-byte hex string (64 hex characters) with a "0x" prefix.
    function generateRandomKey(bytes = 32) {
      return "0x" + crypto.randomBytes(bytes).toString("hex");
    }

    // app.post("/api/aggregateCandidates", async (req, res) => {
    //   try {
    //     let aggregatedCandidates = [];

    //     // Query the SSC candidates collection ("candidates")
    //     const sscData = await db.collection("candidates").find({}).toArray();
    //     sscData.forEach((group) => {
    //       if (Array.isArray(group.candidates)) {
    //         group.candidates.forEach((candidate) => {
    //           // Assign a random unique identifier (32-byte hex string)
    //           candidate.uniqueId = generateRandomKey();
    //           aggregatedCandidates.push(candidate);
    //         });
    //       }
    //     });

    //     // Query the LSC candidates collection ("candidates_lsc")
    //     const lscData = await db.collection("candidates_lsc").find({}).toArray();
    //     lscData.forEach((collegeGroup) => {
    //       if (Array.isArray(collegeGroup.positions)) {
    //         collegeGroup.positions.forEach((position) => {
    //           // Positions with a direct candidates array (e.g., Governor, Vice Governor)
    //           if (Array.isArray(position.candidates)) {
    //             position.candidates.forEach((candidate) => {
    //               candidate.uniqueId = generateRandomKey();
    //               candidate.college = candidate.college || collegeGroup.collegeAcronym || collegeGroup.collegeName;
    //               aggregatedCandidates.push(candidate);
    //             });
    //           }
    //           // Positions with nested programs (e.g., Board Members)
    //           if (Array.isArray(position.programs)) {
    //             position.programs.forEach((programGroup) => {
    //               if (Array.isArray(programGroup.candidates)) {
    //                 programGroup.candidates.forEach((candidate) => {
    //                   candidate.uniqueId = generateRandomKey();
    //                   candidate.college = candidate.college || collegeGroup.collegeAcronym || collegeGroup.collegeName;
    //                   candidate.program = candidate.program || programGroup.program;
    //                   aggregatedCandidates.push(candidate);
    //                 });
    //               }
    //             });
    //           }
    //         });
    //       }
    //     });

    //     // Extract only the unique IDs (which are now valid 32-byte hex strings)
    //     const candidateIds = aggregatedCandidates.map((candidate) => candidate.uniqueId);

    //     // Submit the candidate unique IDs to the blockchain using the smart contract.
    //     const tx = await contract.registerCandidates(candidateIds);
    //     const receipt = await tx.wait();

    //     // Optionally, update your database with the aggregated candidate data
    //     const result = await db.collection("aggregatedCandidates").updateOne({}, { $set: { candidates: aggregatedCandidates } }, { upsert: true });

    //     res.status(200).json({
    //       message: "Candidates aggregated and submitted to blockchain successfully",
    //       count: aggregatedCandidates.length,
    //       dbResult: result,
    //       blockchainTx: receipt,
    //     });
    //   } catch (error) {
    //     console.error("Error aggregating candidates:", error);
    //     res.status(500).json({ error: error.message });
    //   }
    // });

    app.post("/api/aggregateCandidates", async (req, res) => {
      try {
        let aggregatedCandidates = [];

        // Query the SSC candidates collection ("candidates")
        const sscData = await db.collection("candidates").find({}).toArray();
        sscData.forEach((group) => {
          if (Array.isArray(group.candidates)) {
            group.candidates.forEach((candidate) => {
              // Assign a random unique identifier (32-byte hex string)
              candidate.uniqueId = generateRandomKey();
              aggregatedCandidates.push(candidate);
            });
          }
        });

        // Query the LSC candidates collection ("candidates_lsc")
        const lscData = await db.collection("candidates_lsc").find({}).toArray();
        lscData.forEach((collegeGroup) => {
          if (Array.isArray(collegeGroup.positions)) {
            collegeGroup.positions.forEach((position) => {
              // Positions with a direct candidates array (e.g., Governor, Vice Governor)
              if (Array.isArray(position.candidates)) {
                position.candidates.forEach((candidate) => {
                  candidate.uniqueId = generateRandomKey();
                  candidate.college = candidate.college || collegeGroup.collegeAcronym || collegeGroup.collegeName;
                  aggregatedCandidates.push(candidate);
                });
              }
              // Positions with nested programs (e.g., Board Members)
              if (Array.isArray(position.programs)) {
                position.programs.forEach((programGroup) => {
                  if (Array.isArray(programGroup.candidates)) {
                    programGroup.candidates.forEach((candidate) => {
                      candidate.uniqueId = generateRandomKey();
                      candidate.college = candidate.college || collegeGroup.collegeAcronym || collegeGroup.collegeName;
                      candidate.program = candidate.program || programGroup.program;
                      aggregatedCandidates.push(candidate);
                    });
                  }
                });
              }
            });
          }
        });

        // Create maps/sets to track which abstain candidates we need to add.
        // For general positions (not governor, vice governor, or board member), one abstain candidate per position.
        const generalPositions = new Set();
        // For governor and vice governor, we add one per distinct (position + college) combination.
        const govPositionsMap = {};
        // For board member, add one per distinct (position + program) combination.
        const boardPositionsMap = {};

        aggregatedCandidates.forEach((candidate) => {
          const posLower = candidate.position.toLowerCase();
          if (posLower === "governor" || posLower === "vice governor") {
            if (candidate.college) {
              const key = posLower + "_" + candidate.college.toLowerCase();
              govPositionsMap[key] = { position: candidate.position, college: candidate.college };
            }
          } else if (posLower === "board member") {
            if (candidate.program) {
              const key = posLower + "_" + candidate.program.toLowerCase();
              boardPositionsMap[key] = { position: candidate.position, program: candidate.program };
            }
          } else {
            generalPositions.add(candidate.position); // Preserve original case
          }
        });

        // Add abstain candidate for each general position
        generalPositions.forEach((position) => {
          const abstainCandidate = {
            _id: "abstain_" + position.replace(/\s+/g, "_").toLowerCase(),
            party: "",
            name: "Abstain",
            image: "",
            moreInfo: "Abstain",
            position: position,
            uniqueId: generateRandomKey(),
          };
          aggregatedCandidates.push(abstainCandidate);
        });

        // Add abstain candidate for each governor/vice governor (per college)
        Object.values(govPositionsMap).forEach(({ position, college }) => {
          const abstainCandidate = {
            _id: "abstain_" + position.replace(/\s+/g, "_").toLowerCase() + "_" + college.replace(/\s+/g, "_").toLowerCase(),
            party: "",
            name: "Abstain",
            image: "",
            moreInfo: "Abstain",
            position: position,
            college: college,
            uniqueId: generateRandomKey(),
          };
          aggregatedCandidates.push(abstainCandidate);
        });

        // Add abstain candidate for each board member (per program)
        Object.values(boardPositionsMap).forEach(({ position, program }) => {
          const abstainCandidate = {
            _id: "abstain_" + position.replace(/\s+/g, "_").toLowerCase() + "_" + program.replace(/\s+/g, "_").toLowerCase(),
            party: "",
            name: "Abstain",
            image: "",
            moreInfo: "Abstain",
            position: position,
            program: program,
            uniqueId: generateRandomKey(),
          };
          aggregatedCandidates.push(abstainCandidate);
        });

        // Extract only the unique IDs (which are now valid 32-byte hex strings)
        const candidateIds = aggregatedCandidates.map((candidate) => candidate.uniqueId);

        // Submit the candidate unique IDs to the blockchain using the smart contract.
        const tx = await contract.registerCandidates(candidateIds);
        const receipt = await tx.wait();

        // Optionally, update your database with the aggregated candidate data
        const result = await db.collection("aggregatedCandidates").updateOne({}, { $set: { candidates: aggregatedCandidates } }, { upsert: true });

        res.status(200).json({
          message: "Candidates aggregated and submitted to blockchain successfully",
          count: aggregatedCandidates.length,
          dbResult: result,
          blockchainTx: receipt,
        });
      } catch (error) {
        console.error("Error aggregating candidates:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // New API endpoint to list all candidate details (IDs and vote counts) from the blockchain
    app.get("/api/getCandidateDetails", async (req, res) => {
      try {
        // Call the getCandidateDetails function from the contract
        const [candidateIds, voteCounts] = await contract.getCandidateDetails();

        // Convert voteCounts to strings for JSON serialization
        const serializedVoteCounts = voteCounts.map((vote) => vote.toString());

        res.status(200).json({ candidateIds, voteCounts: serializedVoteCounts });
      } catch (error) {
        console.error("Error fetching candidate details:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // app.get("/api/wallet/update", (req, res) => {
    //   res.json({ success: true, message: "Wallet endpoint working." });
    // });

    app.get("/api/compile-contract", (req, res) => {
      try {
        const sourcePath = path.join(__dirname, "contracts", "AdminCandidates.sol");
        const source = fs.readFileSync(sourcePath, "utf8");

        const input = {
          language: "Solidity",
          sources: {
            "AdminCandidates.sol": { content: source },
          },
          settings: {
            outputSelection: {
              "*": {
                "*": ["abi", "evm.bytecode"],
              },
            },
          },
        };

        const output = JSON.parse(solc.compile(JSON.stringify(input)));

        if (output.errors && output.errors.some((error) => error.severity === "error")) {
          return res.status(400).json({ success: false, errors: output.errors });
        }

        // For simplicity, take the first contract found
        const contractNames = Object.keys(output.contracts["AdminCandidates.sol"]);
        if (contractNames.length === 0) {
          return res.status(400).json({ success: false, message: "No contract found." });
        }
        const contractName = contractNames[0];
        const contractArtifact = output.contracts["AdminCandidates.sol"][contractName];

        res.json({ success: true, artifact: contractArtifact });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    // API endpoint to deploy the contract
    // app.post("/api/deploy-contract", async (req, res) => {
    //   try {
    //     // Read and compile the Solidity file
    //     const sourcePath = path.join(__dirname, "contracts", "AdminCandidates.sol");
    //     const source = fs.readFileSync(sourcePath, "utf8");

    //     const input = {
    //       language: "Solidity",
    //       sources: {
    //         "AdminCandidates.sol": { content: source },
    //       },
    //       settings: {
    //         outputSelection: {
    //           "*": {
    //             "*": ["abi", "evm.bytecode"],
    //           },
    //         },
    //       },
    //     };

    //     const output = JSON.parse(solc.compile(JSON.stringify(input)));

    //     if (output.errors && output.errors.some((error) => error.severity === "error")) {
    //       return res.status(400).json({ success: false, errors: output.errors });
    //     }

    //     const contractNames = Object.keys(output.contracts["AdminCandidates.sol"]);
    //     if (contractNames.length === 0) {
    //       return res.status(400).json({ success: false, message: "No contract found." });
    //     }
    //     const contractName = contractNames[0];
    //     const contractArtifact = output.contracts["AdminCandidates.sol"][contractName];
    //     const abi = contractArtifact.abi;
    //     const bytecode = contractArtifact.evm.bytecode.object;

    //     // Set up ethers provider and wallet
    //     const provider = new ethers.providers.JsonRpcProvider(process.env.PROVIDER_URL);
    //     const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    //     const factory = new ethers.ContractFactory(abi, bytecode, wallet);

    //     // Deploy the contract. You can also pass constructor arguments if needed.
    //     const contract = await factory.deploy();

    //     // Wait for deployment to be mined
    //     await contract.deployed();

    //     res.json({
    //       success: true,
    //       address: contract.address,
    //       txHash: contract.deployTransaction.hash,
    //     });
    //   } catch (error) {
    //     res.status(500).json({ success: false, message: error.message });
    //   }
    // });

    app.post("/api/wallet/update", async (req, res) => {
      const { walletAddress, walletName } = req.body;

      // Basic validation
      if (!walletAddress || typeof walletAddress !== "string") {
        return res.status(400).json({ success: false, message: "Invalid wallet address." });
      }
      if (!walletName || typeof walletName !== "string") {
        return res.status(400).json({ success: false, message: "Invalid wallet name." });
      }

      try {
        // Use the admin_wallet collection and a fixed document _id since there's only one wallet.
        const collection = db.collection("admin_wallet");
        await collection.updateOne(
          { _id: "admin_wallet" },
          {
            $set: {
              walletAddress,
              walletName,
              connected: true,
              updatedAt: new Date(),
            },
          },
          { upsert: true }
        );
        res.json({ success: true });
      } catch (err) {
        console.error("Error updating wallet info in DB:", err);
        res.status(500).json({ success: false, message: "Database error" });
      }
    });

    // ==================================================================================================
    //                                            PURE APIs
    // ==================================================================================================

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

    // ==================================================================================================
    //                                        AUTHENTICATION
    // ==================================================================================================

    app.get("/auth/microsoft", passport.authenticate("azure_ad_oauth2"));

    app.get("/auth/microsoft/callback", passport.authenticate("azure_ad_oauth2", { failureRedirect: "/register" }), async (req, res) => {
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
      // Store the original URL the user was trying to access for later redirect
      req.session.returnTo = req.originalUrl;
      res.redirect("/auth/microsoft");
    }

    // ==================================================================================================
    //                                      VOTER LOGIN / SIGNUP
    // ==================================================================================================

    app.get("/register", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      if (!req.user) {
        return res.redirect("/auth/microsoft");
      }

      try {
        const voter = await db.collection("registered_voters").findOne({ email: req.user.email });
        if (voter) {
          // Voter already registered; redirect to homepage with notification flag.
          return res.redirect("/?registered=true");
        } else {
          // Voter not registered; render the registration form.
          res.render("voter/register", { electionConfig, user: req.user, voter: null, status: req.query.status || null });
        }
      } catch (error) {
        console.error("Error checking registration status:", error);
        res.status(500).send("Internal Server Error");
      }
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

    app.get("/admin-login", async (req, res) => {
      res.render("admin/admin-login");
    });

    app.post("/admin-login", async (req, res) => {
      try {
        const { username, password } = req.body;
        console.log("Login attempt for username:", username);

        // Find admin by username
        const admin = await db.collection("admin_accounts").findOne({ username });

        if (!admin) {
          console.log("Admin not found for username:", username);
          return res.redirect("/admin-login?error=invalid_credentials");
        }

        console.log("Admin found:", admin);

        // Direct password comparison (since passwords are stored in plain text)
        if (password !== admin.password) {
          console.log("Incorrect password for username:", username);
          return res.redirect("/admin-login?error=invalid_credentials");
        }

        // Store admin details in session
        req.session.admin = {
          id: admin._id,
          name: admin.name,
          username: admin.username,
          role: admin.role,
          img: admin.img,
        };

        console.log("Session set for admin:", req.session.admin);

        res.redirect("/manage-admins"); // Redirect to dashboard after login
      } catch (error) {
        console.error("Login error:", error);
        res.redirect("/admin-login?error=server_error");
      }
    });

    app.get("/logout", (req, res) => {
      req.session.destroy((err) => {
        if (err) {
          console.error("Error logging out:", err);
          return res.status(500).send("Error logging out");
        }
        res.redirect("/admin-login?loggedOut=true"); // Redirect with a query parameter
      });
    });

    function ensureAdminAuthenticated(req, res, next) {
      if (req.session && req.session.admin) {
        return next();
      }
      // Optionally, store the requested URL for later redirect
      req.session.returnTo = req.originalUrl;
      res.redirect("/admin-login");
    }

    app.get("/manage-admins", ensureAdminAuthenticated, async (req, res) => {
      try {
        // Fetch all admin accounts (using username as unique identifier) from your collection
        const admins = await db.collection("admin_accounts").find({}).toArray();
        // Optionally, fetch additional configuration data if needed
        const electionConfig = (await db.collection("election_config").findOne({})) || {};

        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        console.log("Current Role: ", req.session.admin);
        res.render("admin/system-manage-admins", {
          admins,
          electionConfig,
          loggedInAdmin: req.session.admin,
        });
      } catch (error) {
        console.error("Error retrieving admin accounts:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    // ==================================================================================================
    //                                      DYNAMIC HOMEPAGES
    // ==================================================================================================

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

    // app.get("/get-vote-counts", async (req, res) => {
    //   try {
    //     console.log("📡 Fetching vote counts...");

    //     // Call the contract's getVoteCounts() function
    //     const [candidates, votes] = await contract.getVoteCounts();

    //     const results = candidates.map((c, index) => ({
    //       candidate: ethers.decodeBytes32String(c.name), // Convert bytes32 to string
    //       party: ethers.decodeBytes32String(c.party), // Convert bytes32 to string
    //       votes: votes[index].toString(), // Convert BigNumber to string
    //     }));

    //     console.log("✅ Vote counts retrieved:", results);
    //     res.json({ success: true, results });
    //   } catch (error) {
    //     console.error("❌ Error fetching vote counts:", error);
    //     res.status(500).json({ success: false, error: "Failed to fetch vote counts." });
    //   }
    // });

    // app.get("/api/candidate-details", async (req, res) => {
    //   try {
    //     const positions = await contract.getPositionList();
    //     const [allCandidates, allVotes] = await contract.getVoteCounts();
    //     let result = [];
    //     let totalCandidateCounter = 0;

    //     for (let i = 0; i < positions.length; i++) {
    //       const pos = positions[i];
    //       const decodedPos = ethers.decodeBytes32String(pos);
    //       const posCandidates = await contract.getCandidates(pos);

    //       const candidatesData = await Promise.all(
    //         posCandidates.map(async (candidate, index) => {
    //           const decodedName = ethers.decodeBytes32String(candidate.name);
    //           const decodedParty = ethers.decodeBytes32String(candidate.party);
    //           const votes = Number(allVotes[totalCandidateCounter + index]);
    //           const voterHashesRaw = await contract.getVoterHashes(pos, index);
    //           const voterHashes = voterHashesRaw.map((hash) => ethers.decodeBytes32String(hash));
    //           return {
    //             name: decodedName,
    //             party: decodedParty,
    //             votes,
    //             voterHashes,
    //           };
    //         })
    //       );

    //       totalCandidateCounter += posCandidates.length;
    //       result.push({
    //         position: decodedPos,
    //         candidates: candidatesData,
    //       });
    //     }
    //     res.json({ success: true, result });
    //   } catch (error) {
    //     console.error("Error fetching candidate details:", error);
    //     res.status(500).json({ error: error.message });
    //   }
    // });

    // app.get("/api/candidate-details", async (req, res) => {
    //   try {
    //     const positions = await contract.getPositionList();
    //     const [allCandidates, allVotes] = await contract.getVoteCounts();
    //     let result = [];
    //     let totalCandidateCounter = 0;

    //     for (let i = 0; i < positions.length; i++) {
    //       const pos = positions[i];
    //       const decodedPos = ethers.decodeBytes32String(pos);
    //       const posCandidates = await contract.getCandidates(pos);

    //       const candidatesData = posCandidates.map((candidate, index) => {
    //         const decodedName = ethers.decodeBytes32String(candidate.name);
    //         const decodedParty = ethers.decodeBytes32String(candidate.party);
    //         const votes = Number(allVotes[totalCandidateCounter + index]);
    //         return {
    //           name: decodedName,
    //           party: decodedParty,
    //           votes,
    //         };
    //       });

    //       totalCandidateCounter += posCandidates.length;
    //       result.push({
    //         position: decodedPos,
    //         candidates: candidatesData,
    //       });
    //     }
    //     res.json({ success: true, result });
    //   } catch (error) {
    //     console.error("Error fetching candidate details:", error);
    //     res.status(500).json({ error: error.message });
    //   }
    // });

    app.get("/api/candidate-details", async (req, res) => {
      try {
        const positions = await contract.getPositionList();
        const [allCandidates, allVotes] = await contract.getVoteCounts();

        // Fetch candidates for each position concurrently
        const candidatesPerPosition = await Promise.all(positions.map((pos) => contract.getCandidates(pos)));

        let result = [];
        let totalCandidateCounter = 0;

        for (let i = 0; i < positions.length; i++) {
          const pos = positions[i];
          const decodedPos = ethers.decodeBytes32String(pos);
          const posCandidates = candidatesPerPosition[i];

          // For each candidate, concurrently fetch voter hashes
          const candidatesData = await Promise.all(
            posCandidates.map(async (candidate, index) => {
              const decodedName = ethers.decodeBytes32String(candidate.name);
              const decodedParty = ethers.decodeBytes32String(candidate.party);
              const votes = Number(allVotes[totalCandidateCounter + index]);
              const voterHashesRaw = await contract.getVoterHashes(pos, index);
              const voterHashes = voterHashesRaw.map((hash) => ethers.decodeBytes32String(hash));
              return {
                name: decodedName,
                party: decodedParty,
                votes,
                voterHashes,
              };
            })
          );

          totalCandidateCounter += posCandidates.length;
          result.push({
            position: decodedPos,
            candidates: candidatesData,
          });
        }

        res.json({ success: true, result });
      } catch (error) {
        console.error("Error fetching candidate details:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // ==================================================================================================
    //                                         VOTING PROCESS
    // ==================================================================================================

    app.get("/test-vote", async (req, res) => {
      res.render("voter/test-vote");
    });

    app.get("/ballot", ensureAuthenticated, async (req, res) => {
      try {
        // Verify that the voter is registered.
        const registeredVoter = await db.collection("registered_voters").findOne({ email: req.user.email });
        if (!registeredVoter) {
          return res.redirect("/register?error=not_registered");
        }

        // Get the voter's college and program.
        const fullCollege = registeredVoter.college; // e.g., "College of Science (ABC)"
        const program = registeredVoter.program; // e.g., "BS Computer Science"
        const collegeMatch = fullCollege.match(/\(([^)]+)\)/);
        const college = collegeMatch ? collegeMatch[1] : fullCollege;

        // Fetch all candidate groups from blockchain_candidates.
        const blockchainCandidatesCollection = db.collection("blockchain_candidates");
        const allCandidateGroups = await blockchainCandidatesCollection.find({}).toArray();

        // Define global positions.
        const globalPositionNames = ["President", "Vice President", "Senator", "Senators"];

        // Filter groups for global positions.
        const globalCandidates = allCandidateGroups.filter((group) => {
          const posStr = ethers.decodeBytes32String(group.position);
          return globalPositionNames.includes(posStr);
        });

        // For college-specific candidates, we assume the position is stored as "COLLEGE - POSITION"
        // For example: "ABC - Governor", "ABC - Vice Governor", or "ABC - Board Member - X"
        const collegeCandidates = allCandidateGroups.filter((group) => {
          const posStr = ethers.decodeBytes32String(group.position);
          return posStr.startsWith(`${college} -`);
        });

        // Now separate out the college-specific positions.
        // Governor: look for "Governor" (but not "Vice Governor" or "Board Member").
        const governorCandidates = collegeCandidates.filter((group) => {
          const posStr = ethers.decodeBytes32String(group.position);
          return posStr.includes("Governor") && !posStr.includes("Vice Governor") && !posStr.includes("Board Member");
        });

        // Vice Governor: look for "Vice Governor".
        const viceGovernorCandidates = collegeCandidates.filter((group) => {
          const posStr = ethers.decodeBytes32String(group.position);
          return posStr.includes("Vice Governor");
        });

        // Board Member: look for "Board Member" and then, if candidate entries have program info, filter by voter's program.
        let boardMemberCandidates = collegeCandidates.filter((group) => {
          const posStr = ethers.decodeBytes32String(group.position);
          return posStr.includes("Board Member");
        });

        // If candidate entries include a 'program' field, only include those matching the voter's program.
        boardMemberCandidates = boardMemberCandidates.filter((group) => {
          if (!group.candidates || group.candidates.length === 0) return false;
          // Check if at least one candidate in the group has a program field matching the voter's program.
          return group.candidates.some((candidate) => {
            if (candidate.program) {
              return candidate.program === program;
            }
            // If no candidate in the group has program info, assume it's not program-specific.
            return true;
          });
        });

        // Construct the ballot object with six positions.
        const ballot = {
          president: globalCandidates.filter((group) => ethers.decodeBytes32String(group.position) === "President"),
          vicePresident: globalCandidates.filter((group) => ethers.decodeBytes32String(group.position) === "Vice President"),
          senators: globalCandidates.filter((group) => {
            const pos = ethers.decodeBytes32String(group.position);
            return pos === "Senator" || pos === "Senators";
          }),
          governor: governorCandidates,
          viceGovernor: viceGovernorCandidates,
          boardMember: boardMemberCandidates,
        };

        // Console log the candidate groups.
        console.log("Ballot Candidates:");
        console.log("Global Positions:");
        console.log("President:", ballot.president);
        console.log("Vice President:", ballot.vicePresident);
        console.log("Senators:", ballot.senators);
        console.log(`College-Specific (${college}) Positions:`);
        console.log("Governor:", ballot.governor);
        console.log("Vice Governor:", ballot.viceGovernor);
        console.log("Board Member:", ballot.boardMember);

        // Send the ballot response.
        res.json({ ballot });
      } catch (error) {
        console.error("Error fetching ballot candidates:", error);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    app.get("/vote", ensureAuthenticated, async (req, res) => {
      try {
        // Check if the voter is registered
        const registeredVoter = await db.collection("registered_voters").findOne({ email: req.user.email });
        if (!registeredVoter) {
          return res.redirect("/register?error=not_registered");
        }

        // Extract the voter's college and program
        const fullCollege = registeredVoter.college;
        const collegeMatch = fullCollege.match(/\(([^)]+)\)/);
        const college = collegeMatch ? collegeMatch[1] : fullCollege;
        const program = registeredVoter.program;

        // Fetch the aggregated candidates document from the database
        const aggregatedDoc = await db.collection("aggregatedCandidates").findOne({});
        const candidates = aggregatedDoc ? aggregatedDoc.candidates : [];

        // Filter candidates per individual position:
        const presidentCandidates = candidates.filter((candidate) => candidate.position.toLowerCase() === "president");
        const vicePresidentCandidates = candidates.filter((candidate) => candidate.position.toLowerCase() === "vice president");
        const senatorCandidates = candidates.filter((candidate) => candidate.position.toLowerCase() === "senator");

        // Separate governor and vice governor candidates based on college match
        const governorCandidates = candidates.filter((candidate) => candidate.position.toLowerCase() === "governor" && candidate.college && candidate.college.toLowerCase() === college.toLowerCase());
        const viceGovernorCandidates = candidates.filter((candidate) => candidate.position.toLowerCase() === "vice governor" && candidate.college && candidate.college.toLowerCase() === college.toLowerCase());

        // For board member candidates, filter by both college and program match
        const boardCandidates = candidates.filter((candidate) => candidate.position.toLowerCase() === "board member" && candidate.college && candidate.college.toLowerCase() === college.toLowerCase() && candidate.program && candidate.program.toLowerCase() === program.toLowerCase());

        console.log(presidentCandidates);
        console.log(vicePresidentCandidates);
        console.log(senatorCandidates);
        console.log(governorCandidates);
        console.log(viceGovernorCandidates);
        console.log(boardCandidates);

        // Render the view with separate arrays for each position
        res.render("voter/vote", {
          presidentCandidates,
          vicePresidentCandidates,
          senatorCandidates,
          governorCandidates,
          viceGovernorCandidates,
          boardCandidates,
        });
      } catch (error) {
        console.error("Error fetching candidates:", error);
        res.status(500).send("Failed to fetch candidates");
      }
    });

    app.get("/review", async (req, res) => {
      res.render("voter/review");
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

    // Helper: Convert a vote key (e.g., "president") into the candidate position expected by the contract.
    // Format positions based on the vote key and voterCollege for college-specific offices.
    // Helper: Format positions using voterCollege for college-specific offices.
    function formatPosition(position, voterCollege) {
      // For positions that require a college prefix.
      if ((position === "governor" || position === "viceGovernor") && voterCollege && voterCollege.trim() !== "") {
        const posLabel = position === "governor" ? "Governor" : "Vice Governor";
        return ethers.encodeBytes32String(`${voterCollege.toUpperCase()} - ${posLabel}`);
      }
      // For non-college-specific positions.
      const mapping = {
        president: "President",
        vicePresident: "Vice President",
        senator: "Senator",
      };
      return ethers.encodeBytes32String(mapping[position] || position);
    }

    // Standard lookup for positions with an exact match.
    async function findCandidateIndex(formattedPosition, candidateName) {
      try {
        const candidates = await contract.getCandidates(formattedPosition);
        for (let i = 0; i < candidates.length; i++) {
          const candidateEntryName = ethers.decodeBytes32String(candidates[i].name);
          if (candidateEntryName === candidateName) {
            return i;
          }
        }
      } catch (err) {
        console.error("Error in findCandidateIndex:", err);
      }
      return -1;
    }

    // For board members, search across all board member positions for the given college.
    async function findBoardMemberCandidateIndex(voterCollege, candidateName) {
      if (!voterCollege || voterCollege.trim() === "") {
        console.error("voterCollege is required for board member votes.");
        return null;
      }
      try {
        const positions = await contract.getPositionList();
        const prefix = `${voterCollege.toUpperCase()} - Board Member -`;
        for (const pos of positions) {
          const posName = ethers.decodeBytes32String(pos);
          if (posName.startsWith(prefix)) {
            const candidates = await contract.getCandidates(pos);
            for (let i = 0; i < candidates.length; i++) {
              const candName = ethers.decodeBytes32String(candidates[i].name);
              if (candName === candidateName) {
                return { position: pos, index: i };
              }
            }
          }
        }
      } catch (err) {
        console.error("Error in findBoardMemberCandidateIndex:", err);
      }
      return null;
    }

    // app.post("/submit-vote", async (req, res) => {
    //   try {
    //     const { votes, voterHash, voterCollege, voterProgram } = req.body;

    //     if (!voterHash || typeof voterHash !== "string") {
    //       console.log("❌ Invalid voterHash received:", voterHash);
    //       return res.status(400).json({ error: "Invalid voter hash!" });
    //     }

    //     // Ensure the voter hash is a valid hex string by prepending "0x" if missing.
    //     const validVoterHash = voterHash.startsWith("0x") ? voterHash : "0x" + voterHash;
    //     console.log("📡 Formatted Voter Hash:", validVoterHash);

    //     let nonce = await provider.getTransactionCount(wallet.address, "pending");
    //     console.log("📡 Current nonce:", nonce);

    //     const batchVotes = [];
    //     const votePositions = Object.keys(votes);

    //     // For testing: use hard-coded votes for specific positions.
    //     for (const positionKey of votePositions) {
    //       if (positionKey === "governor") {
    //         const formattedPosition = ethers.encodeBytes32String("CS - Governor");
    //         batchVotes.push({ position: formattedPosition, index: 1 });
    //         continue;
    //       }
    //       if (positionKey === "viceGovernor") {
    //         const formattedPosition = ethers.encodeBytes32String("CS - Vice Governor");
    //         batchVotes.push({ position: formattedPosition, index: 1 });
    //         continue;
    //       }
    //       if (positionKey === "boardMember") {
    //         const formattedPosition = ethers.encodeBytes32String("CS - Board Member - 6");
    //         batchVotes.push({ position: formattedPosition, index: 0 });
    //         continue;
    //       }

    //       // For other positions (using default behavior for testing)
    //       const formattedPosition = ethers.encodeBytes32String(positionKey);
    //       const voteData = votes[positionKey];
    //       if (Array.isArray(voteData)) {
    //         for (const candidate of voteData) {
    //           batchVotes.push({ position: formattedPosition, index: 0 });
    //         }
    //       } else {
    //         batchVotes.push({ position: formattedPosition, index: 0 });
    //       }
    //     }

    //     if (batchVotes.length === 0) {
    //       return res.status(400).json({ error: "No valid votes to submit." });
    //     }

    //     console.log("✅ Final batchVotes:", JSON.stringify(batchVotes, null, 2));

    //     const positionsArray = batchVotes.map((vote) => vote.position);
    //     const indicesArray = batchVotes.map((vote) => vote.index);

    //     console.log("📡 Submitting transaction...");
    //     const tx = await contract.connect(wallet).batchVote(positionsArray, indicesArray, validVoterHash, { nonce });
    //     console.log("📡 Transaction submitted. Hash:", tx.hash);
    //     await tx.wait();
    //     console.log("✅ Transaction confirmed!");

    //     req.session.voterReceipt = { votes, voterHash: validVoterHash, voterCollege, voterProgram, txHash: tx.hash };

    //     res.status(200).json({
    //       message: "Votes successfully submitted to blockchain!",
    //       transactionHash: tx.hash,
    //       redirect: "/verify",
    //     });
    //   } catch (error) {
    //     console.error("❌ Error submitting votes:", error);
    //     res.status(500).json({ error: "Failed to submit votes." });
    //   }
    // });

    app.post("/submit-vote", async (req, res) => {
      try {
        const { voterHash } = req.body;

        if (!voterHash || typeof voterHash !== "string") {
          console.log("❌ Invalid voterHash received:", voterHash);
          return res.status(400).json({ error: "Invalid voter hash!" });
        }

        // Ensure the voter hash is a valid hex string.
        const validVoterHash = voterHash.startsWith("0x") ? voterHash : "0x" + voterHash;
        console.log("📡 Formatted Voter Hash:", validVoterHash);

        let nonce = await provider.getTransactionCount(wallet.address, "pending");
        console.log("📡 Current nonce:", nonce);

        // Hard-coded votes array for testing.
        // Order: President, Vice President, Senator, Senator, Governor, Vice Governor, Board Member.
        const hardCodedVotes = [
          { position: ethers.encodeBytes32String("President"), index: 0 },
          { position: ethers.encodeBytes32String("Vice President"), index: 0 },
          { position: ethers.encodeBytes32String("Senator"), index: 0 },
          { position: ethers.encodeBytes32String("Senator"), index: 0 },
          { position: ethers.encodeBytes32String("CS - Governor"), index: 1 },
          { position: ethers.encodeBytes32String("CS - Vice Governor"), index: 1 },
          { position: ethers.encodeBytes32String("CS - Board Member - 6"), index: 0 },
        ];

        console.log("✅ Final hard-coded batchVotes:", JSON.stringify(hardCodedVotes, null, 2));

        const positionsArray = hardCodedVotes.map((vote) => vote.position);
        const indicesArray = hardCodedVotes.map((vote) => vote.index);

        console.log("📡 Submitting transaction...");
        const tx = await contract.connect(wallet).batchVote(positionsArray, indicesArray, validVoterHash, { nonce });
        console.log("📡 Transaction submitted. Hash:", tx.hash);
        await tx.wait();
        console.log("✅ Transaction confirmed!");

        // For testing, store the receipt in session (if using session middleware)
        req.session.voterReceipt = { voterHash: validVoterHash, txHash: tx.hash };

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

    app.get("/verify", async (req, res) => {
      const voterReceipt = req.session.voterReceipt;

      if (!voterReceipt) {
        return res.redirect("/vote"); // Redirect to voting page if no data
      }

      res.render("voter/verify", {
        votes: voterReceipt.votes,
        voterHash: voterReceipt.voterHash,
        voterCollege: voterReceipt.voterCollege,
        voterProgram: voterReceipt.voterProgram,
        txHash: voterReceipt.txHash,
      });
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
          res.redirect("/candidates");
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
        res.redirect("/candidates");
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

    // ==================================== SUBMIT CANDIDATES  ====================================
    // console.log("Ethers object:", ethers);
    // console.log("Ethers utils:", ethers.utils);

    function toBytes32(str) {
      // If no string, encode an empty string
      if (!str) return ethers.encodeBytes32String("");
      // Limit string to 31 characters so there's room for the null terminator
      return ethers.encodeBytes32String(str.slice(0, 31));
    }

    function fromBytes32(hexStr) {
      try {
        // Try decoding normally first
        return ethers.decodeBytes32String(hexStr);
      } catch (error) {
        // If it fails, force a null terminator:
        let bytes = ethers.arrayify(hexStr);
        // Ensure the last byte is 0
        if (bytes[bytes.length - 1] !== 0) {
          bytes[bytes.length - 1] = 0;
        }
        return ethers.toUtf8String(bytes);
      }
    }

    app.get("/get-vote-counts", async (req, res) => {
      try {
        const positions = await contract.getPositionList();
        const [allCandidates, allVotes] = await contract.getVoteCounts();
        const boardProgramsCollection = db.collection("board_member_programs");

        // Fetch candidate arrays concurrently.
        const candidatesPerPosition = await Promise.all(positions.map((pos) => contract.getCandidates(pos)));

        // Build a list of board member lookups.
        const boardLookupRequests = [];
        const boardLookupIndexes = [];
        positions.forEach((pos, index) => {
          const decodedPos = fromBytes32(pos);
          if (decodedPos.indexOf("Board Member") !== -1) {
            // For board member positions, queue up the lookup.
            boardLookupIndexes.push(index);
            boardLookupRequests.push(
              (async () => {
                const programID = await contract.boardMemberProgramIDs(pos);
                if (programID !== ethers.encodeBytes32String("")) {
                  const boardProgram = await boardProgramsCollection.findOne({
                    programID: programID.toString(),
                  });
                  return boardProgram ? boardProgram.programText : "";
                }
                return "";
              })()
            );
          }
        });
        // Wait for all board member program texts concurrently.
        const boardProgramResults = await Promise.all(boardLookupRequests);
        // Build a map: position index => program text.
        const boardProgramMap = {};
        boardLookupIndexes.forEach((idx, i) => {
          boardProgramMap[idx] = boardProgramResults[i];
        });

        // Build final result.
        let result = [];
        let totalCandidateCounter = 0;
        for (let i = 0; i < positions.length; i++) {
          const pos = positions[i];
          let decodedPos = fromBytes32(pos);
          const posCandidates = candidatesPerPosition[i];

          // If this is a Board Member position, modify the display name using our pre-fetched map.
          if (decodedPos.indexOf("Board Member") !== -1 && boardProgramMap[i]) {
            const parts = decodedPos.split(" - ");
            // Reconstruct with the program text.
            decodedPos = `${parts[0]} - Board Member - ${boardProgramMap[i]}`;
          }

          const candidatesData = posCandidates.map((candidate, index) => {
            const decodedName = fromBytes32(candidate.name);
            const decodedParty = fromBytes32(candidate.party);
            const votes = Number(allVotes[totalCandidateCounter + index]);
            return { name: decodedName, party: decodedParty, votes };
          });
          totalCandidateCounter += posCandidates.length;
          let positionObj = {
            position: decodedPos,
            candidates: candidatesData,
          };
          result.push(positionObj);
        }

        res.json({ success: true, result });
      } catch (error) {
        console.error("Error fetching candidate details:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.post("/submit-candidates", async (req, res) => {
      try {
        const candidatesCollection = db.collection("candidates");
        const candidatesLscCollection = db.collection("candidates_lsc");
        const boardProgramsCollection = db.collection("board_member_programs");
        const blockchainCandidatesCollection = db.collection("blockchain_candidates"); // New collection

        // Fetch candidates from both collections.
        const candidatesData = await candidatesCollection.find({}).toArray();
        const candidatesLscData = await candidatesLscCollection.find({}).toArray();

        console.log("\n🚀 SUBMIT-CANDIDATES API CALLED!");
        console.log("✅ Main candidates fetched:", candidatesData.length);
        console.log("✅ LSC candidates fetched:", candidatesLscData.length);

        let positions = [];
        let candidates = []; // 2D array for CandidateEntry structs (for blockchain submission).
        let boardMemberProgramIDs = [];
        let blockchainData = []; // Stores plain text structured data for MongoDB

        // Process main candidates collection.
        candidatesData.forEach((group) => {
          if (!group.candidates || group.candidates.length === 0) {
            console.log(`❌ Skipping ${group.position} (No candidates)`);
            boardMemberProgramIDs.push(ethers.encodeBytes32String(""));
          } else {
            console.log(`✅ Adding ${group.position} with ${group.candidates.length} candidates`);
            // For blockchain submission, encode the position.
            positions.push(ethers.encodeBytes32String(group.position));

            let formattedCandidates = group.candidates.map((c) => {
              // For blockchain submission, encode the candidate fields.
              let candidateEntry = {
                name: ethers.encodeBytes32String(c.name),
                party: ethers.encodeBytes32String(c.party),
              };

              // For MongoDB storage, use plain text.
              let candidateForDB = {
                name: c.name,
                party: c.party,
                votes: 0, // Blockchain initializes votes at 0
                image: c.image || "",
                moreInfo: c.moreInfo || "",
              };

              // Add college if position is Governor or Vice Governor.
              if (group.position.includes("Governor")) {
                candidateForDB.college = group.college || "";
              }

              return { blockchain: candidateEntry, mongo: candidateForDB };
            });

            // Store the encoded candidates for blockchain submission.
            candidates.push(formattedCandidates.map((c) => c.blockchain));
            boardMemberProgramIDs.push(ethers.encodeBytes32String(""));

            // Store plain text data in MongoDB.
            blockchainData.push({
              position: group.position, // plain text
              candidates: formattedCandidates.map((c) => c.mongo),
            });
          }
        });

        let boardMemberCounter = {};

        // Process LSC candidates collection.
        for (const college of candidatesLscData) {
          console.log(`\n📌 Processing LSC College: ${college.collegeName}`);
          if (!boardMemberCounter[college.collegeAcronym]) {
            boardMemberCounter[college.collegeAcronym] = 0;
          }

          for (const pos of college.positions) {
            if (pos.position === "Board Member") {
              for (const program of pos.programs) {
                if (!program.candidates || program.candidates.length === 0) {
                  console.log(`❌ Skipping Board Member - ${program.program} (No candidates)`);
                } else {
                  let count = boardMemberCounter[college.collegeAcronym];
                  boardMemberCounter[college.collegeAcronym] += 1;
                  const uniqueKey = `${college.collegeAcronym} - Board Member - ${count}`;

                  console.log(`✅ Adding Board Member for ${college.collegeAcronym} under key "${uniqueKey}"`);
                  positions.push(ethers.encodeBytes32String(uniqueKey));

                  let formattedCandidates = program.candidates.map((c) => {
                    let candidateEntry = {
                      name: ethers.encodeBytes32String(c.name),
                      party: ethers.encodeBytes32String(c.party),
                    };

                    let candidateForDB = {
                      name: c.name,
                      party: c.party,
                      votes: 0,
                      image: c.image || "",
                      moreInfo: c.moreInfo || "",
                      college: college.collegeName || "",
                      program: program.program || "",
                    };

                    return { blockchain: candidateEntry, mongo: candidateForDB };
                  });

                  candidates.push(formattedCandidates.map((c) => c.blockchain)); // Encoded for blockchain.
                  const programID = ethers.encodeBytes32String(uniqueKey);
                  boardMemberProgramIDs.push(programID);

                  blockchainData.push({
                    position: uniqueKey, // plain text key.
                    candidates: formattedCandidates.map((c) => c.mongo),
                    program_id: programID,
                  });

                  console.log(`Upserting program for key "${uniqueKey}": "${program.program}"`);
                  await boardProgramsCollection.updateOne({ programID: programID.toString() }, { $set: { programText: program.program } }, { upsert: true });
                }
              }
            } else {
              if (!pos.candidates || pos.candidates.length === 0) {
                console.log(`❌ Skipping ${pos.position} for ${college.collegeAcronym} (No candidates)`);
                boardMemberProgramIDs.push(ethers.encodeBytes32String(""));
              } else {
                console.log(`✅ Adding ${pos.position} for ${college.collegeAcronym} with ${pos.candidates.length} candidates`);
                const plainPosition = `${college.collegeAcronym} - ${pos.position}`;
                positions.push(ethers.encodeBytes32String(plainPosition));

                let formattedCandidates = pos.candidates.map((c) => ({
                  name: ethers.encodeBytes32String(c.name),
                  party: ethers.encodeBytes32String(c.party),
                }));

                candidates.push(formattedCandidates);
                boardMemberProgramIDs.push(ethers.encodeBytes32String(""));

                blockchainData.push({
                  position: plainPosition, // plain text
                  candidates: pos.candidates.map((c) => ({
                    name: c.name,
                    party: c.party,
                    votes: 0,
                    image: c.image || "",
                    moreInfo: c.moreInfo || "",
                  })),
                });
              }
            }
          }
        }

        // Add "Abstain" option for blockchain submission.
        positions.forEach((pos, index) => {
          candidates[index].push({
            name: ethers.encodeBytes32String("Abstain"),
            party: ethers.encodeBytes32String("None"),
          });
        });

        // Also add "Abstain" option to the plain text data for MongoDB.
        blockchainData.forEach((item) => {
          item.candidates.push({
            name: "Abstain",
            party: "None",
            votes: 0,
            image: "",
            moreInfo: "",
          });
        });

        console.log("\n📌 FINAL SUBMISSION:");
        console.log({ positions, candidates, boardMemberProgramIDs });

        if (positions.length === 0) {
          console.log("⚠️ No candidates to submit!");
          return res.status(400).json({ error: "No candidates to submit." });
        }

        console.log("📡 Sending transaction to blockchain...");
        const tx = await contract.submitCandidates(positions, candidates, boardMemberProgramIDs);
        await tx.wait();
        console.log("✅ Candidates submitted successfully!");

        // Store structured data in MongoDB exactly like blockchain but in plain text.
        await blockchainCandidatesCollection.deleteMany({});
        await blockchainCandidatesCollection.insertMany(blockchainData);

        console.log("✅ Candidates stored in blockchain_candidates collection");

        const statusCollection = db.collection("system_status");
        await statusCollection.updateOne({ _id: "candidate_submission" }, { $set: { submitted: true } }, { upsert: true });

        res.json({ message: "Candidates successfully submitted to blockchain and stored in MongoDB!" });
      } catch (error) {
        console.error("❌ ERROR submitting candidates:", error);
        res.status(500).json({ error: "Failed to submit candidates." });
      }
    });

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

    // Helper to calculate the current period based on configuration and current date
    function calculateCurrentPeriod(config, now) {
      if (!config.registrationStart || !config.registrationEnd || !config.votingStart || !config.votingEnd) {
        return { name: "Election Not Active", duration: "Configuration Incomplete", waitingFor: null };
      }

      const options = { month: "long", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true };

      const regStart = new Date(config.registrationStart);
      const regEnd = new Date(config.registrationEnd);
      const voteStart = new Date(config.votingStart);
      const voteEnd = new Date(config.votingEnd);

      const formatDate = (date) => date.toLocaleString("en-US", options).replace(" at ", " - "); // Ensures correct format

      if (now < regStart) {
        return { name: "Waiting for Registration Period", duration: `${formatDate(now)} to ${formatDate(regStart)}`, waitingFor: "Registration" };
      } else if (now >= regStart && now <= regEnd) {
        return { name: "Registration Period", duration: `${formatDate(regStart)} to ${formatDate(regEnd)}` };
      } else if (now > regEnd && now < voteStart) {
        return { name: "Waiting for Voting Period", duration: `${formatDate(regEnd)} to ${formatDate(voteStart)}`, waitingFor: "Voting" };
      } else if (now >= voteStart && now <= voteEnd) {
        return { name: "Voting Period", duration: `${formatDate(voteStart)} to ${formatDate(voteEnd)}` };
      } else if (now > voteEnd) {
        if (config.electionStatus === "Results Are Out") {
          return { name: "Results Are Out Period", duration: `${formatDate(voteEnd)} to (Waiting for Admin)` };
        } else {
          return { name: "Results Double Checking Period", duration: `${formatDate(voteEnd)} to (Waiting for Admin)` };
        }
      }

      return { name: "Election Not Active", duration: "N/A" };
    }

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

    app.post("/reset-election", async (req, res) => {
      try {
        console.log("Reset election initiated.");

        // Check if candidates have been submitted
        console.log("Checking candidate submission status...");
        const submissionStatus = await db.collection("system_status").findOne({ _id: "candidate_submission" });
        console.log("Submission status retrieved:", submissionStatus);

        if (submissionStatus && submissionStatus.submitted === true) {
          console.log("Candidates have been submitted. Archiving candidate data...");

          // Archive candidates data
          const candidatesData = await db.collection("candidates").find({}).toArray();
          const candidatesLscData = await db.collection("candidates_lsc").find({}).toArray();

          const archiveResult = await db.collection("election_archive").insertOne({
            electionName: "Previous Election",
            registrationStart: submissionStatus.registrationStart || null,
            registrationEnd: submissionStatus.registrationEnd || null,
            votingStart: submissionStatus.votingStart || null,
            votingEnd: submissionStatus.votingEnd || null,
            electionStatus: "Candidates Submitted",
            archivedAt: new Date(),
            candidates: candidatesData,
            candidatesLsc: candidatesLscData,
          });
          console.log("Candidate data archived. Archive ID:", archiveResult.insertedId);

          // Reset blockchain candidates
          // console.log("Triggering contract.resetCandidates()...");
          // const tx = await contract.resetCandidates();
          // await tx.wait();
          // console.log("Blockchain candidate reset confirmed.");

          // Update the submission status to false
          await db.collection("system_status").updateOne({ _id: "candidate_submission" }, { $set: { submitted: false } });
          console.log("Candidate submission status updated to false.");
        } else {
          console.log("Candidate submission status is not true. Skipping candidate archiving and blockchain reset.");
        }

        // Reset election configuration
        console.log("Resetting election configuration...");
        await db.collection("election_config").deleteMany({});
        await db.collection("election_config").insertOne({
          _id: "election_config", // <-- FIXED
          electionName: "BulSU Student 2025",
          registrationPeriod: { start: "", end: "" },
          votingPeriod: { start: "", end: "" },
          totalElections: 14,
          totalPartylists: 0,
          partylists: ["bulsu", "bulsuan"],
          totalCandidates: 0,
          phase: "Election Inactive",
          listOfElections: [
            { acronym: "CAFA", name: "College of Architecture and Fine Arts", voters: 0, registeredVoters: 0, numberOfVoted: 0 },
            { acronym: "CAL", name: "College of Arts and Letters", voters: 0, registeredVoters: 0, numberOfVoted: 0 },
            { acronym: "CBEA", name: "College of Business Education and Accountancy", voters: 0, registeredVoters: 0, numberOfVoted: 0 },
            { acronym: "CCJE", name: "College of Criminal Justice Education", voters: 0, registeredVoters: 0, numberOfVoted: 0 },
            { acronym: "CHTM", name: "College of Hospitality and Tourism Management", voters: 0, registeredVoters: 0, numberOfVoted: 0 },
            { acronym: "CIT", name: "College of Industrial Technology", voters: 0, registeredVoters: 0, numberOfVoted: 0 },
            { acronym: "CICT", name: "College of Information and Communications Technology", voters: 0, registeredVoters: 0, numberOfVoted: 0 },
            { acronym: "COE", name: "College of Engineering", voters: 0, registeredVoters: 0, numberOfVoted: 0 },
            { acronym: "COED", name: "College of Education", voters: 0, registeredVoters: 0, numberOfVoted: 0 },
            { acronym: "CN", name: "College of Nursing", voters: 0, registeredVoters: 0, numberOfVoted: 0 },
            { acronym: "CS", name: "College of Science", voters: 0, registeredVoters: 0, numberOfVoted: 0 },
            { acronym: "CSER", name: "College of Sports, Exercise, and Recreation", voters: 0, registeredVoters: 0, numberOfVoted: 0 },
            { acronym: "CSSP", name: "College of Social Sciences and Philosophy", voters: 0, registeredVoters: 0, numberOfVoted: 0 },
          ],
          currentPeriod: { name: "Registration Period", duration: "", waitingFor: null },
          electionStatus: "Registration Period",
          updatedAt: new Date(),
          registrationStart: new Date("2025-02-05T15:21:00.000Z"),
          registrationEnd: new Date("2025-02-19T15:21:00.000Z"),
          votingStart: new Date("2025-02-20T15:22:00.000Z"),
          votingEnd: new Date("2025-02-21T15:22:00.000Z"),
          totalStudents: 0,
          fakeCurrentDate: "2025-02-12T12:40:00.000Z",
        });

        console.log("Election configuration reset complete.");

        res.redirect("configuration");
      } catch (error) {
        console.error("Error resetting election:", error);
        res.status(500).json({ message: "Error resetting election", error: error.message });
      }
    });

    // ==================================================================================================
    //                                         ADMIN TABS
    // ==================================================================================================

    app.get("/dashboard", ensureAdminAuthenticated, async (req, res) => {
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
      res.render("admin/dashboard", { electionConfig, loggedInAdmin: req.session.admin });
    });

    // GET /configuration
    app.get("/configuration", ensureAdminAuthenticated, async (req, res) => {
      let electionConfig = (await db.collection("election_config").findOne({})) || {
        electionName: "",
        registrationStart: "",
        registrationEnd: "",
        votingStart: "",
        votingEnd: "",
        partylists: [],
        listOfElections: [], // Use listOfElections to store college data (voters, registeredVoters, numberOfVoted)
        totalStudents: 0,
        fakeCurrentDate: null,
        electionStatus: "Election Not Active",
        currentPeriod: { name: "Election Not Active", duration: "", waitingFor: null },
      };

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);
      const simulatedDate = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate).toISOString() : null;
      res.render("admin/configuration", { electionConfig, simulatedDate, loggedInAdmin: req.session.admin });
    });

    app.post("/configuration", async (req, res) => {
      try {
        // First, get the current configuration from the database.
        let currentConfig = (await db.collection("election_config").findOne({})) || {};

        const { electionName, registrationStart, registrationEnd, votingStart, votingEnd, partylists, colleges } = req.body;
        // If partylists is not provided, keep the existing one
        const partylistsArray = partylists ? partylists.split(",").map((item) => item.trim()) : currentConfig.partylists || [];

        // Mapping from college acronym to full name.
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

        // If new college data is provided, recalculate mergedList and totalStudents.
        // Otherwise, keep the existing ones.
        let mergedList = currentConfig.listOfElections || [];
        let totalStudents = currentConfig.totalStudents || 0;
        if (colleges && Object.keys(colleges).length > 0) {
          mergedList = [];
          totalStudents = 0;
          // The form sends only voters value per college.
          // For each college, preserve registeredVoters and numberOfVoted from the current config if available.
          for (const acronym in colleges) {
            const voters = parseInt(colleges[acronym], 10) || 0;
            totalStudents += voters;
            // Look for previous data for this college.
            let prevCollege = (currentConfig.listOfElections || []).find((c) => c.acronym === acronym);
            const registeredVoters = prevCollege ? prevCollege.registeredVoters : 0;
            const numberOfVoted = prevCollege ? prevCollege.numberOfVoted : 0;
            mergedList.push({
              acronym: acronym,
              name: collegeMapping[acronym] || acronym,
              voters: voters,
              registeredVoters: registeredVoters,
              numberOfVoted: numberOfVoted,
            });
          }
        }

        // Build the update object by merging new values with existing ones if not provided.
        const update = {
          electionName: electionName || currentConfig.electionName,
          registrationStart: registrationStart ? new Date(registrationStart) : currentConfig.registrationStart,
          registrationEnd: registrationEnd ? new Date(registrationEnd) : currentConfig.registrationEnd,
          votingStart: votingStart ? new Date(votingStart) : currentConfig.votingStart,
          votingEnd: votingEnd ? new Date(votingEnd) : currentConfig.votingEnd,
          partylists: partylistsArray,
          listOfElections: mergedList,
          totalStudents: totalStudents,
          // Set electionStatus and currentPeriod as needed (here defaulting to Registration Period)
          electionStatus: "Registration Period",
          currentPeriod: { name: "Registration Period", duration: "", waitingFor: null },
          updatedAt: new Date(),
        };

        await db.collection("election_config").updateOne({}, { $set: update, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
        const savedConfig = await db.collection("election_config").findOne({});
        console.log("Saved Configuration:", savedConfig);
        res.redirect("configuration?saved=true");
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

    app.get("/candidates", ensureAdminAuthenticated, async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});

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

        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        res.render("admin/candidates", {
          candidates: allCandidates,
          candidates_lsc: structuredData,
          voterCounts,
          electionConfig,
          loggedInAdmin: req.session.admin,
        });
      } catch (error) {
        console.error("Error fetching candidates for dashboard:", error);
        res.status(500).send("Failed to fetch candidates data for the dashboard");
      }
    });

    app.get("/blockchain-management", ensureAdminAuthenticated, async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      res.render("admin/blockchain-management", { electionConfig, loggedInAdmin: req.session.admin });
    });
    app.get("/blockchain-activity-log", ensureAdminAuthenticated, async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      res.render("admin/blockchain-activity-log", { electionConfig, loggedInAdmin: req.session.admin });
    });

    app.get("/voter-info", ensureAdminAuthenticated, async (req, res) => {
      try {
        const voters = await db.collection("registered_voters").find().toArray();

        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});

        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        res.render("admin/election-voter-info", { voters, electionConfig, loggedInAdmin: req.session.admin }); // Pass voters to EJS template
      } catch (error) {
        console.error("Error fetching registered voters:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.get("/voter-turnout", ensureAdminAuthenticated, async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      res.render("admin/election-voter-turnout", { electionConfig, loggedInAdmin: req.session.admin });
    });

    app.get("/vote-tally", async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});

        const votersCollection = db.collection("voters");
        const colleges = await votersCollection.find({}).toArray();
        const voterCounts = {};

        colleges.forEach((college) => {
          voterCounts[college.acronym] = {
            name: college.college,
            voters: college.voters,
          };
        });
        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        res.render("admin/election-vote-tally", { voterCounts, electionConfig, loggedInAdmin: req.session.admin });
      } catch (error) {
        console.error("Error fetching voter counts:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.get("/results", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      res.render("admin/election-results", { electionConfig, loggedInAdmin: req.session.admin });
    });

    app.get("/reset", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      res.render("admin/election-reset", { electionConfig, loggedInAdmin: req.session.admin });
    });

    app.get("/archives", async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});
        const archives = await db.collection("election_archive").find({}).toArray();

        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);
        res.render("admin/archives", { archives, electionConfig, loggedInAdmin: req.session.admin });
      } catch (error) {
        console.error("Error fetching archives:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.get("/edit-account", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      res.render("admin/system-edit-account", { electionConfig, loggedInAdmin: req.session.admin });
    });

    app.get("/admin-accounts", async (req, res) => {
      try {
        const admins = await db.collection("admin_accounts").find({}).toArray();
        res.json(admins);
      } catch (error) {
        console.error("Error retrieving admin accounts:", error);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    app.get("/admin-accounts/:username", async (req, res) => {
      try {
        if (!["Technical Team", "Developers"].includes(req.session.admin.role)) {
          return res.status(403).json({ error: "Unauthorized access." });
        }

        const username = req.params.username;
        const admin = await db.collection("admin_accounts").findOne({ username });

        if (!admin) {
          return res.status(404).json({ error: "Admin not found." });
        }

        res.json(admin);
      } catch (error) {
        console.error("Error retrieving admin:", error);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // Add New Admin (Base64 Image)
    app.post("/admin-accounts/add", async (req, res) => {
      try {
        if (!["Technical Team", "Developers"].includes(req.session.admin.role)) {
          return res.status(403).json({ error: "Only Technical Team or Developers can add new admins." });
        }

        const { name, username, password, role, imgBase64 } = req.body;

        // Validate role
        const allowedRoles = ["Electoral Board", "Technical Team", "Creatives Team", "Developers"];
        if (!allowedRoles.includes(role)) {
          return res.status(400).json({ error: "Invalid role selected" });
        }

        // Ensure username is unique
        const existingAdmin = await db.collection("admin_accounts").findOne({ username });
        if (existingAdmin) {
          return res.status(400).json({ error: "Username already exists." });
        }

        const newAdmin = {
          name,
          username,
          password, // Plain-text password (not recommended for security)
          role,
          img: imgBase64,
        };

        await db.collection("admin_accounts").insertOne(newAdmin);
        res.redirect("/manage-admins");
      } catch (error) {
        console.error("Error adding admin:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.post("/admin-accounts/edit/:username", async (req, res) => {
      try {
        if (!["Technical Team", "Developers"].includes(req.session.admin.role)) {
          return res.status(403).json({ error: "Only Technical Team or Developers can edit admin accounts." });
        }

        const username = req.params.username;
        const { name, newUsername, role, imgBase64 } = req.body;

        const updateFields = {
          name,
          username: newUsername || username, // Allow updating username
          role,
          img: imgBase64,
        };

        await db.collection("admin_accounts").updateOne(
          { username }, // Find by username
          { $set: updateFields }
        );

        res.redirect("/manage-admins");
      } catch (error) {
        console.error("Error editing admin:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    // Delete Admin
    app.post("/admin-accounts/delete/:username", async (req, res) => {
      try {
        if (!["Technical Team", "Developers"].includes(req.session.admin.role)) {
          return res.status(403).json({ error: "Only Technical Team or Developers can delete admin accounts." });
        }

        const username = req.params.username;
        await db.collection("admin_accounts").deleteOne({ username });

        res.redirect("/manage-admins");
      } catch (error) {
        console.error("Error deleting admin:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.get("/help-page", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      res.render("admin/system-help-page", { electionConfig, loggedInAdmin: req.session.admin });
    });
    app.get("/system-activity-log", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      res.render("admin/system-activity-log", { electionConfig, loggedInAdmin: req.session.admin });
    });

    // Routing
    app.get("/about", async (req, res) => {
      res.render("about");
    });

    app.get("/contact", async (req, res) => {
      res.render("contact");
    });

    /*
 Expected JSON payload for voting:

{
  "voterId": "unique_voter_identifier",
  "college": "CSSP",
  "votes": {
    "president": 0,
    "vicePresident": 1,
    "senators": [2, 0, 1],
    "governor": 0,
    "viceGovernor": 1,
    "boardMember": 0,
    "boardMemberKey": "CSSP - Board Member - 0"
  }
}

Notes:
- For single-choice positions (President, Vice President), a single candidate index is provided.
- For multi-choice positions like senators, an array of candidate indices is allowed.
- College-specific positions (Governor, Vice Governor) are built using the college variable.
- For board member votes, a boardMemberKey must be supplied so the correct board member group is targeted.
*/

    app.post("/vote", async (req, res) => {
      try {
        const { voterId, college, votes } = req.body;
        if (!voterId || !college || !votes) {
          return res.status(400).json({ error: "Missing voterId, college, or votes" });
        }

        let positions = [];
        let indices = [];

        // Single-choice votes
        if (votes.president !== undefined) {
          positions.push(ethers.encodeBytes32String("President"));
          indices.push(votes.president);
        }
        if (votes.vicePresident !== undefined) {
          positions.push(ethers.encodeBytes32String("Vice President"));
          indices.push(votes.vicePresident);
        }

        // Multi-choice: Senators (allowing multiple votes)
        if (Array.isArray(votes.senators)) {
          votes.senators.forEach((candidateIndex) => {
            positions.push(ethers.encodeBytes32String("Senator"));
            indices.push(candidateIndex);
          });
        }

        // College-specific positions (e.g., Governor and Vice Governor)
        if (votes.governor !== undefined) {
          const governorPos = `${college} - Governor`;
          positions.push(ethers.encodeBytes32String(governorPos));
          indices.push(votes.governor);
        }
        if (votes.viceGovernor !== undefined) {
          const viceGovernorPos = `${college} - Vice Governor`;
          positions.push(ethers.encodeBytes32String(viceGovernorPos));
          indices.push(votes.viceGovernor);
        }

        // Board Member vote (based on the voter's program)
        // Expecting a boardMemberKey which was used during candidate submission
        if (votes.boardMember !== undefined && votes.boardMemberKey) {
          positions.push(ethers.encodeBytes32String(votes.boardMemberKey));
          indices.push(votes.boardMember);
        }

        // Create a unique voter hash.
        // Here we use keccak256 on the voterId (converted to UTF-8 bytes)
        const voterHash = ethers.keccak256(ethers.toUtf8Bytes(voterId));

        // Submit the votes in one transaction using batchVote.
        const tx = await contract.batchVote(positions, indices, voterHash);
        await tx.wait();

        res.json({ message: "Vote submitted successfully!", txHash: tx.hash });
      } catch (error) {
        console.error("Vote submission error:", error);
        res.status(500).json({ error: "Failed to submit vote", details: error.toString() });
      }
    });

    // Example function to list out all candidate positions and their indices
    async function listAllCandidates() {
      try {
        // Get the list of positions (each is a bytes32 value)
        const positions = await contract.getPositionList();

        // Iterate over each position
        for (const pos of positions) {
          // Decode the bytes32 position to a string
          const positionName = ethers.toUtf8String(pos);
          console.log(`Position: ${positionName}`);

          // Retrieve the candidates for this position
          const candidates = await contract.getCandidates(pos);

          // List each candidate with its index
          candidates.forEach((candidate, index) => {
            const candidateName = ethers.toUtf8String(candidate.name);
            const candidateParty = ethers.toUtf8String(candidate.party);
            console.log(`  Index ${index}: ${candidateName} - ${candidateParty}`);
          });
        }
      } catch (error) {
        console.error("Error listing candidates:", error);
      }
    }

    // await listAllCandidates();

    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to connect to the database:", error);
    process.exit(1);
  }
};

startServer();
