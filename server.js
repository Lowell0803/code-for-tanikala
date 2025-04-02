const express = require("express");
const path = require("path");
const { connectToDatabase, client } = require("./db");
const { Parser } = require("json2csv");
const archiver = require("archiver");

require("dotenv").config();
const session = require("express-session");

const axios = require("axios");

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

async function recordBlockchainActivity(collectionName, action, actor, req, txReceipt, cryptoPrices) {
  let db = await connectToDatabase();
  let totalGasUsed = 0;
  let transactionHash = "N/A";
  let costPhp = "N/A";
  let costPol = "N/A";

  // Check if txReceipt is an array (batch transaction)
  if (Array.isArray(txReceipt)) {
    // Sum gasUsed from each receipt
    txReceipt.forEach((receipt) => {
      totalGasUsed += Number(receipt.gasUsed);
    });
    // Use the hash of the first receipt as the transaction hash
    transactionHash = txReceipt[0].hash;
  } else if (txReceipt) {
    totalGasUsed = Number(txReceipt.gasUsed);
    transactionHash = txReceipt.hash;
  }

  // Calculate cost details if cryptoPrices is provided
  if (cryptoPrices) {
    let combinedCostWei = 0;
    if (Array.isArray(txReceipt)) {
      txReceipt.forEach((receipt) => {
        combinedCostWei += Number(receipt.gasUsed) * Number(receipt.gasPrice);
      });
    } else if (txReceipt) {
      combinedCostWei = totalGasUsed * Number(txReceipt.gasPrice);
    }

    const amountSpentPol = combinedCostWei / 1e18;
    costPhp = cryptoPrices.polPricePhp ? (amountSpentPol * cryptoPrices.polPricePhp).toFixed(2) : "N/A";
    costPol = amountSpentPol.toFixed(4);
  }

  const logEntry = {
    timestamp: new Date(),
    transactionHash,
    action,
    costPhp,
    costPol,
    actor,
    ip: req.ip,
  };
  await db.collection(collectionName).insertOne(logEntry);
}

async function getCryptoPrices() {
  try {
    const response = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,polygon-ecosystem-token&vs_currencies=php,usd");
    console.log("API Response:", response.data);

    const ethData = response.data.ethereum || { php: 0, usd: 0 };
    const polData = response.data["polygon-ecosystem-token"] || { php: 0, usd: 0 };

    return {
      ethPricePhp: ethData.php || 0,
      ethPriceUsd: ethData.usd || 0,
      polPricePhp: polData.php || 0,
      polPriceUsd: polData.usd || 0,
    };
  } catch (error) {
    console.error("Error fetching crypto prices:", error.message);
    return null;
  }
}

const Agenda = require("agenda");

const agenda = new Agenda({
  db: { address: process.env.MONGODB_URI, collection: "agendaJobs" },
});

// Define the vote submission job with concurrency set to 1.
agenda.define("process vote submission", { concurrency: 1, lockLifetime: 60000 }, async (job) => {
  const { voteId, candidateIds, hashedEmail, email, socketId } = job.attrs.data;
  try {
    // Start a MongoDB session for the transaction (ensure your MongoDB deployment supports transactions)
    const session = client.startSession();

    let nonce;
    try {
      await session.withTransaction(async () => {
        const nonceDoc = await db.collection("nonces").findOneAndUpdate({ _id: "nonce" }, { $inc: { value: 1 } }, { returnDocument: "after", upsert: true, session });
        nonce = nonceDoc.value.value;
        console.log("Distributed nonce acquired:", nonce);
      });
    } finally {
      await session.endSession();
    }

    // Send the blockchain transaction using the unique nonce.
    const tx = await contract.voteForCandidates(candidateIds, { nonce });
    const receipt = await tx.wait();

    // Update waiting vote record as completed.
    const waitingCollection = db.collection("waiting_votes");
    await waitingCollection.updateOne(
      { voteId },
      {
        $set: {
          status: "completed",
          txHash: tx.hash,
          completedAt: new Date(),
        },
      }
    );

    // Calculate the new queue length (number of pending votes)
    const newQueueLength = await waitingCollection.countDocuments({ status: "pending" });

    // Emit the updated queue length to all connected clients
    io.emit("voteQueueUpdate", { queueNumber: newQueueLength });

    // Update candidate_hashes collection.
    const candidateHashesCollection = db.collection("candidate_hashes");
    await Promise.all(candidateIds.map((candidateId) => candidateHashesCollection.updateOne({ candidateId }, { $addToSet: { emails: hashedEmail } }, { upsert: true })));

    // Update the registered_voters collection to change status from "Registered" to "Voted".
    if (email) {
      await db.collection("registered_voters").updateOne({ email: email }, { $set: { status: "Voted" } });
    }
    console.log("Email: ", email);

    // Notify client via Socket.IO, if socketId is provided.
    if (socketId) {
      io.to(voteId).emit("voteConfirmed", { txHash: tx.hash });
    }

    // Fetch crypto prices for cost calculation
    const cryptoPrices = await getCryptoPrices();
    if (!cryptoPrices) {
      console.log("Failed to fetch crypto prices for vote submission logging.");
    }

    // Create a fake request object for logging purposes (since no req is available in the job)
    const fakeReq = { ip: "N/A" };

    // Log blockchain activity for vote submission
    await recordBlockchainActivity("blockchain_activity_logs", "Vote Submitted", "Voter", fakeReq, receipt, cryptoPrices);

    // --- NEW SECTION: Update blockchain_management collection ---
    const gasUsed = Number(receipt.gasUsed);
    const gasPrice = Number(receipt.gasPrice);
    const voteCost = gasUsed * gasPrice; // cost in wei
    const voteCostInPOL = voteCost / 1e18; // cost in POL (assuming 1 POL = 1e18 wei)

    // Fetch crypto prices for conversion
    let polPriceUsd = 0;
    let polPricePhp = 0;
    if (cryptoPrices) {
      polPriceUsd = cryptoPrices.polPriceUsd;
      polPricePhp = cryptoPrices.polPricePhp;
    }

    // Calculate the total amounts in USD and PHP
    const amountSpentUSD = voteCostInPOL * polPriceUsd;
    const amountSpentPHP = voteCostInPOL * polPricePhp;

    await db.collection("blockchain_management").updateOne(
      {},
      {
        $set: { latestVoteCost: voteCostInPOL },
        $inc: {
          voteTransactionsCount: 1,
          totalGasUsed: gasUsed,
          totalWeiSpent: voteCost,
          totalAmountSpentPol: voteCostInPOL,
          totalAmountSpentUSD: amountSpentUSD,
          totalAmountSpentPHP: amountSpentPHP,
        },
      }
    );

    // --- End new section ---
  } catch (error) {
    console.error("Error processing vote submission:", error);
    await db.collection("waiting_votes").updateOne(
      { voteId },
      {
        $set: {
          status: "error",
          error: error.message,
          completedAt: new Date(),
        },
      }
    );
    if (socketId) {
      io.to(voteId).emit("voteError", { error: error.message });
    }
  }
});

// Start Agenda when it's ready
agenda.on("ready", () => {
  agenda.start();
});

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

const callbackURL = process.env.IS_DEV_MODE === "true" ? "http://localhost:3000/auth/microsoft/callback" : "https://tanikala-bulsu.com/auth/microsoft/callback";

passport.use(
  new AzureOAuth2Strategy(
    {
      clientID: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      callbackURL, // Use our dynamic callback URL
      tenant: process.env.MICROSOFT_TENANT_ID,
      resource: "https://graph.microsoft.com",
      scope: ["openid", "email", "profile", "User.Read"],
    },
    async (accessToken, refreshToken, params, profile, done) => {
      try {
        // Decode the JWT token from Microsoft
        const decodedToken = JSON.parse(Buffer.from(params.id_token.split(".")[1], "base64").toString("utf8"));

        // Extract basic details
        const userEmail = decodedToken.email || decodedToken.preferred_username || decodedToken.upn;
        const userName = decodedToken.name;

        // Call Microsoft Graph API for additional user details
        const response = await fetch("https://graph.microsoft.com/v1.0/me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        const userProfile = await response.json();

        const user = {
          name: userProfile.displayName || userName,
          email: userProfile.mail || userEmail,
          jobTitle: userProfile.jobTitle || "N/A",
          department: userProfile.department || "N/A",
          school: userProfile.officeLocation || "N/A",
        };

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

const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

io.on("connection", (socket) => {
  console.log("Client connected: " + socket.id);

  // Get the admin email from the handshake query (make sure the client sends it)
  const adminEmail = socket.handshake.query.email;
  if (adminEmail) {
    // Mark the admin as online
    db.collection("admin_accounts")
      .updateOne({ email: adminEmail }, { $set: { online: true } })
      .catch((err) => console.error("Error marking admin online:", err));
  }

  socket.on("joinVoteRoom", (data) => {
    const { voteId } = data;
    if (voteId) {
      socket.join(voteId);
      console.log(`Socket ${socket.id} joined room ${voteId}`);
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected: " + socket.id);
    if (adminEmail) {
      // Mark the admin as offline
      db.collection("admin_accounts")
        .updateOne({ email: adminEmail }, { $set: { online: false } })
        .catch((err) => console.error("Error marking admin offline:", err));
    }
  });
});

let db;

const { MongoClient, ExplainVerbosity } = require("mongodb");

const startServer = async () => {
  try {
    db = await connectToDatabase();

    const currentNonce = await wallet.getNonce();
    await db.collection("nonces").updateOne({ _id: "nonce" }, { $set: { value: currentNonce } }, { upsert: true });

    async function testTransaction() {
      const session = db.client.startSession();
      try {
        await session.withTransaction(async () => {
          // Try updating a test document in a test collection
          await db.collection("testCollection").updateOne({ _id: "testDoc" }, { $set: { test: "transaction" } }, { upsert: true, session });
        });
        console.log("Transaction committed successfully.");
      } catch (error) {
        console.error("Transaction failed:", error);
      } finally {
        await session.endSession();
      }
    }

    testTransaction();

    /**
     * Logs an activity to a specified MongoDB collection.
     *
     * This function retrieves the currently logged in admin's details from the session (or falls back to req.user),
     * and records the event using the admin's username (or name) and role.
     *
     * @param {string} collectionName - The MongoDB collection to insert the log into.
     * @param {string} eventName - A description of the event (what happened).
     * @param {string} activityType - The type/category of activity (e.g., "CREATE", "UPDATE", "DELETE").
     * @param {object} req - The Express request object (from which the current admin is extracted).
     * @param {string} [details='No details'] - Optional additional details for the log entry.
     */
    async function logActivity(collectionName, eventName, activityType, req, details = "No details") {
      try {
        let adminUsername = "Unknown Admin";
        let adminRole = "Unknown Role";
        let adminEmail = "Unknown Email";

        // If activityType is "Voter", assign student info to log
        if (activityType === "Voter") {
          const studentDetails = req.body; // Assuming student details are in req.body from the registration form
          adminUsername = studentDetails.fullName || "Unknown Student";
          adminRole = "Student";
          adminEmail = studentDetails.email || "Unknown Email";
        } else {
          // Check for admin details in session; fall back to req.user if needed.
          let adminDetails = req.session && req.session.admin;

          if (adminDetails) {
            // Use the admin details from the session.
            adminUsername = adminDetails.username || adminDetails.name || "Unknown Admin";
            adminRole = adminDetails.role || "Unknown Role";
            adminEmail = adminDetails.email || "Unknown Email";
          } else if (req.user) {
            // Fallback if using a different authentication method.
            adminUsername = req.user.username || req.user.name || "Unknown Admin";
            adminRole = req.user.role || "Unknown Role";
            adminEmail = req.user.email || "Unknown Email";
          }
        }

        // Create the log entry object with a timestamp and provided details.
        const logEntry = {
          timestamp: new Date(),
          eventName, // Description of the event
          activityType, // Type of activity (e.g., "CREATE", "UPDATE")
          details, // Additional details about the event
          adminEmail, // Email (either admin or student depending on activityType)
          adminUsername, // The admin's or student's username (or name if username is unavailable)
          adminRole, // The admin's or student's role
        };

        // Insert the log entry into the specified collection.
        await db.collection(collectionName).insertOne(logEntry);
      } catch (error) {
        console.error("Error logging activity:", error);
      }
    }

    const { ObjectId } = require("mongodb");

    // Updated: Generate a 32-byte hex string (64 hex characters) with a "0x" prefix.

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

        // Insert the new voter into the database
        await db.collection("registered_voters").insertOne(newVoter);

        // Log the registration activity
        const eventName = `Student ${studentNumber} has registered`;
        const activityType = "Voter"; // As this is a new registration (creation of a new voter)
        await logActivity("system_activity_logs", eventName, activityType, req, `Registered student with ID: ${studentNumber}`);
        console.log(eventName);

        res.redirect("/?new_reg=true");
      } catch (error) {
        console.error("Error registering voter:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.get("/auth/microsoft", passport.authenticate("azure_ad_oauth2"));

    // app.get("/auth/microsoft/callback", passport.authenticate("azure_ad_oauth2", { failureRedirect: "/register" }), async (req, res) => {
    //   const voter = await db.collection("registered_voters").findOne({ email: req.user.email });
    //   if (!voter) {
    //     return res.redirect("/register?error=not_registered");
    //   }
    //   const redirectUrl = req.session.returnTo || "/";
    //   delete req.session.returnTo;
    //   res.redirect(redirectUrl);
    // });
    app.get("/auth/microsoft/callback", passport.authenticate("azure_ad_oauth2", { failureRedirect: "/register" }), async (req, res) => {
      const voter = await db.collection("registered_voters").findOne({ email: req.user.email });
      if (!voter) {
        return res.redirect("/register?error=not_registered");
      }
      // Redirect to the stored returnTo URL or default to "/vote"
      const redirectUrl = req.session.returnTo || "/vote";
      delete req.session.returnTo; // Clear after use
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

      // If it's not the Registration Period, redirect to "/" with an error message.
      if (electionConfig.currentPeriod.name !== "Registration Period") {
        return res.redirect("/?error=" + encodeURIComponent("Registration period is not active"));
      }

      if (!req.user) {
        return res.redirect("/auth/microsoft");
      }

      try {
        const voter = await db.collection("registered_voters").findOne({ email: req.user.email });

        if (voter) {
          // Voter already registered
          return res.redirect("/?registered=true");
        }

        // Check if the user has agreed to the privacy policy
        if (!req.query.agree) {
          return res.render("voter/data-privacy", { electionConfig, user: req.user });
        }

        // If agreed, show the registration form
        res.render("voter/register", { electionConfig, user: req.user, voter: null, status: req.query.status || null });
      } catch (error) {
        console.error("Error checking registration status:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.get("/data-privacy", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);
      res.render("voter/data-privacy", { electionConfig });
    });

    app.get("/admin-login", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      res.render("admin/admin-login", { electionConfig });
    });

    app.post("/admin-login", async (req, res) => {
      try {
        const { email, password } = req.body;
        console.log("Login attempt for email:", email);

        // Find admin by email
        const admin = await db.collection("admin_accounts").findOne({ email });

        if (!admin) {
          console.log("Admin not found for email:", email);
          return res.redirect("/admin-login?error=invalid_credentials");
        }

        console.log("Admin found:", admin);

        // Direct password comparison (since passwords are stored in plain text)
        if (password !== admin.password) {
          console.log("Incorrect password for email:", email);
          return res.redirect("/admin-login?error=invalid_credentials");
        }

        // Store admin details in session
        req.session.admin = {
          id: admin._id,
          name: admin.name,
          email: admin.email,
          role: admin.role,
          password: admin.password,
          img: admin.img,
        };

        console.log("Session set for admin:", req.session.admin);

        // Save the session explicitly before redirecting
        req.session.save((err) => {
          if (err) {
            console.error("Session save error:", err);
            return res.redirect("/admin-login?error=session_error");
          }
          res.redirect("/dashboard"); // Redirect to dashboard after login
        });
      } catch (error) {
        console.error("Login error:", error);
        res.redirect("/admin-login?error=server_error");
      }
    });

    app.get("/voter/logout", (req, res) => {
      req.session.destroy((err) => {
        if (err) {
          console.error("Error logging out:", err);
          return res.status(500).send("Error logging out");
        }
        res.redirect("/?logged_out=true");
      });
    });

    app.get("/logout", (req, res) => {
      req.session.destroy((err) => {
        if (err) {
          console.error("Error logging out:", err);
          return res.status(500).send("Error logging out");
        }
        res.redirect("/admin-login");
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

    // app.get("/manage-admins", ensureAdminAuthenticated, async (req, res) => {
    //   try {
    //     // Fetch all admin accounts (using username as unique identifier) from your collection
    //     const admins = await db.collection("admin_accounts").find({}).toArray();
    //     // Optionally, fetch additional configuration data if needed
    //     const electionConfig = (await db.collection("election_config").findOne({})) || {};

    //     const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
    //     electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

    //     console.log("Current Role: ", req.session.admin);
    //     res.render("admin/system-manage-admins", {
    //       admins,
    //       electionConfig,
    //       loggedInAdmin: req.session.admin,
    //       moment,
    //     });
    //   } catch (error) {
    //     console.error("Error retrieving admin accounts:", error);
    //     res.status(500).send("Internal Server Error");
    //   }
    // });

    // Existing route
    app.get("/manage-admins", ensureAdminAuthenticated, async (req, res) => {
      try {
        // Fetch all admin accounts (using username as unique identifier) from your collection
        const admins = await db.collection("admin_accounts").find({}).toArray();
        // Optionally, fetch additional configuration data if needed
        const electionConfig = (await db.collection("election_config").findOne({})) || {};
        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);
        console.log("Current Role: ", req.session.admin.id);
        res.render("admin/system-manage-admins", {
          admins,
          electionConfig,
          loggedInAdmin: req.session.admin,
          moment,
        });
      } catch (error) {
        console.error("Error retrieving admin accounts:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.post("/admin-accounts/add", ensureAdminAuthenticated, async (req, res) => {
      try {
        console.log("Received request to add admin account.");
        // Destructure the fields from the request body; notice no status field.
        const { name, email, role, password, img } = req.body;

        // Create a new admin account object with online set to false by default.
        const newAdmin = {
          name,
          email,
          role,
          password, // (Remember: you should hash passwords in production.)
          online: false, // Default status is inactive
          img,
        };

        // Insert the new admin into your database.
        const result = await db.collection("admin_accounts").insertOne(newAdmin);

        if (result.insertedId) {
          console.log("New admin added successfully:", result.insertedId);
          res.redirect("/manage-admins");
        } else {
          console.error("Failed to add new admin account.");
          res.status(400).send("Unable to add admin account.");
        }
      } catch (error) {
        console.error("Error adding admin account:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    // New route to update an admin account using _id as the unique identifier
    app.post("/admin-accounts/edit", ensureAdminAuthenticated, async (req, res) => {
      try {
        console.log("========================================");
        console.log("Received request to update admin account.");
        console.log("Request body:", req.body);

        // Extract the fields from the request body, including the id
        const { id, name, email, role, password, status, img } = req.body;
        console.log("Parsed values:");
        console.log("id:", id);
        console.log("name:", name);
        console.log("email:", email);
        console.log("role:", role);
        console.log("password:", password);
        console.log("status:", status);
        console.log("img:", img);

        // Construct the update data
        // const updateData = {
        //   name,
        //   email,
        //   role,
        //   password, // Consider hashing if needed
        //   online: status === "Active",
        //   img,
        // };
        const updateData = {
          name,
          email,
          role,
          password, // (hash the password if needed)
          // Do not update the online status – keep it as is.
          img,
        };

        console.log("Constructed updateData object:", updateData);

        // Convert id to ObjectId
        const objectId = new ObjectId(id);
        console.log("Converted id to ObjectId:", objectId);

        // Update the admin account using the _id as the identifier
        console.log("About to update document with _id:", objectId);
        const result = await db.collection("admin_accounts").updateOne({ _id: objectId }, { $set: updateData });
        console.log("MongoDB update result:", result);

        if (result.modifiedCount === 1) {
          console.log("Update successful. Redirecting to /manage-admins");
          res.redirect("/manage-admins");
        } else {
          console.log("Update failed. No documents were modified.");
          res.status(400).send("Unable to update admin account.");
        }
        console.log("========================================");
      } catch (error) {
        console.error("Error updating admin account:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    // (Optional) Route to delete an admin account
    app.post("/admin-accounts/delete", ensureAdminAuthenticated, async (req, res) => {
      console.log("=== /admin-accounts/delete route called ===");
      try {
        const { email } = req.body;
        console.log("Email received for deletion:", email);

        if (!email) {
          console.warn("No email provided in request body.");
          return res.status(400).send("Email is required to delete an admin account.");
        }

        console.log("Attempting to delete admin with email:", email);
        const result = await db.collection("admin_accounts").deleteOne({ email });
        console.log("MongoDB deletion result:", result);

        if (result.deletedCount === 1) {
          console.log("Deletion successful for admin with email:", email);
          res.redirect("/manage-admins");
        } else {
          console.warn("Deletion did not remove any documents for email:", email);
          res.status(400).send("Unable to delete admin account.");
        }
      } catch (error) {
        console.error("Error deleting admin account:", error);
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

    // app.get("/", async (req, res) => {
    //   // Retrieve the configuration or use defaults
    //   const electionConfigCollection = db.collection("election_config");
    //   let electionConfig = await electionConfigCollection.findOne({});

    //   const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
    //   electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

    //   console.log("Dynamic Index Route: Raw electionConfig from DB:", electionConfig);

    //   // Use the fake current date if available; otherwise, use the actual current date.
    //   // const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
    //   console.log("Dynamic Index Route: Using current date =", now);

    //   // Compute the current phase based on the dates and current/fake date
    //   const currentPeriod = computeCurrentPeriod(electionConfig, now);
    //   console.log("Dynamic Index Route: Computed current period =", currentPeriod);

    //   // Update the election configuration object to reflect the computed period
    //   electionConfig.currentPeriod = currentPeriod;

    //   // Determine the homepage view based on the computed current period name
    //   const homepageView = getHomepageView(currentPeriod.name);
    //   console.log("Dynamic Index Route: Rendering view =", homepageView);

    //   // Render the view with the updated configuration and current date
    //   res.render(homepageView, { electionConfig, currentDate: now.toISOString() });
    // });

    app.get("/", async (req, res) => {
      try {
        // Retrieve election configuration document (assuming a single document)
        const electionConfig = await db.collection("election_config").findOne({});

        // Convert stored dates to moment objects in Asia/Manila timezone.
        const fakeCurrent = electionConfig && electionConfig.useFakeDate === true ? moment.tz(electionConfig.fakeCurrentDate, "Asia/Manila") : moment.tz(new Date(), "Asia/Manila");

        const electionStatus = electionConfig && electionConfig.electionStatus ? electionConfig.electionStatus : "";
        const specialStatus = electionConfig && electionConfig.specialStatus ? electionConfig.specialStatus : "None";

        const regStart = electionConfig && electionConfig.registrationStart ? moment.tz(electionConfig.registrationStart, "Asia/Manila") : null;
        const regEnd = electionConfig && electionConfig.registrationEnd ? moment.tz(electionConfig.registrationEnd, "Asia/Manila") : null;
        const voteStart = electionConfig && electionConfig.votingStart ? moment.tz(electionConfig.votingStart, "Asia/Manila") : null;
        const voteEnd = electionConfig && electionConfig.votingEnd ? moment.tz(electionConfig.votingEnd, "Asia/Manila") : null;

        console.log(electionStatus);
        console.log(specialStatus);
        console.log(regStart + " to " + regEnd);
        console.log(voteStart + " to " + voteEnd);

        // Determine which homepage to serve based on the logic.
        let homepage = "";

        const currentDate = moment.tz(new Date(), "Asia/Manila");

        if (electionStatus !== "ELECTION ACTIVE") {
          homepage = "index-election-not-active.ejs";
        } else {
          // Election is active.
          if (specialStatus !== "None") {
            if (specialStatus === "System Temporarily Closed") {
              homepage = "index-system-temporarily-closed.ejs";
            } else if (specialStatus === "Results Are Out") {
              homepage = "index-results-are-out-period.ejs";
            } else {
              // Fallback if an unexpected specialStatus is provided.
              homepage = "index-election-not-active.ejs";
            }
          } else {
            // specialStatus is "None" so determine based on date comparisons.
            if (regStart && fakeCurrent.isBefore(regStart)) {
              homepage = "index-registration-period.ejs";
            } else if (regStart && regEnd && fakeCurrent.isBetween(regStart, regEnd, null, "[)")) {
              homepage = "index-registration-period.ejs";
            } else if (regEnd && voteStart && fakeCurrent.isBetween(regEnd, voteStart, null, "[)")) {
              homepage = "index-voting-period.ejs";
            } else if (voteStart && voteEnd && fakeCurrent.isBetween(voteStart, voteEnd, null, "[)")) {
              homepage = "index-voting-period.ejs";
            } else if (voteEnd && fakeCurrent.isAfter(voteEnd)) {
              homepage = "index-vote-checking-period.ejs";
            } else {
              // Fallback if no conditions match.
              homepage = "index-election-not-active.ejs";
            }
          }
        }

        // Render the chosen homepage EJS file from the homepages folder.
        // Pass in electionConfig, moment, and any helper functions your view might need.
        res.render(`homepages/${homepage}`, {
          electionConfig,
          moment,
          currentDate,
        });
      } catch (err) {
        console.error("Error in home route:", err);
        res.status(500).send("Internal Server Error");
      }
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

    async function getCryptoPrices() {
      try {
        const response = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,polygon-ecosystem-token&vs_currencies=php,usd");
        console.log("API Response:", response.data);

        const ethData = response.data.ethereum || { php: 0, usd: 0 };
        const polData = response.data["polygon-ecosystem-token"] || { php: 0, usd: 0 };

        return {
          ethPricePhp: ethData.php || 0,
          ethPriceUsd: ethData.usd || 0,
          polPricePhp: polData.php || 0,
          polPriceUsd: polData.usd || 0,
        };
      } catch (error) {
        console.error("Error fetching crypto prices:", error.message);
        return null;
      }
    }

    function generateRandomKey(bytes = 32) {
      return "0x" + crypto.randomBytes(bytes).toString("hex");
    }

    // Public wallet address to track

    app.post("/submit-candidates", async (req, res) => {
      try {
        // Helper function to assign a unique ID and merge additional fields
        const processCandidates = (candidates, extra = {}) =>
          candidates.map((candidate) => ({
            ...candidate,
            uniqueId: generateRandomKey(),
            ...extra,
          }));

        // Query SSC and LSC candidates concurrently
        const [sscData, lscData] = await Promise.all([db.collection("candidates").find({}).toArray(), db.collection("candidates_lsc").find({}).toArray()]);

        let aggregatedCandidates = [];

        // Process SSC candidates
        sscData.forEach((group) => {
          if (Array.isArray(group.candidates)) {
            aggregatedCandidates.push(...processCandidates(group.candidates));
          }
        });

        // Process LSC candidates
        lscData.forEach((collegeGroup) => {
          if (!Array.isArray(collegeGroup.positions)) return;
          collegeGroup.positions.forEach((position) => {
            // For positions with direct candidates
            if (Array.isArray(position.candidates)) {
              const extra = {
                college: position.college || collegeGroup.collegeAcronym || collegeGroup.collegeName,
              };
              aggregatedCandidates.push(...processCandidates(position.candidates, extra));
            }
            // For positions with nested programs
            if (Array.isArray(position.programs)) {
              position.programs.forEach((programGroup) => {
                if (Array.isArray(programGroup.candidates)) {
                  const extra = {
                    college: programGroup.college || collegeGroup.collegeAcronym || collegeGroup.collegeName,
                    program: programGroup.program,
                  };
                  aggregatedCandidates.push(...processCandidates(programGroup.candidates, extra));
                }
              });
            }
          });
        });

        // Build maps to determine which abstain candidates need to be added
        const generalPositions = new Set();
        const govPositionsMap = {};
        const boardPositionsMap = {};

        aggregatedCandidates.forEach((candidate) => {
          const posLower = candidate.position.toLowerCase();
          if (posLower === "governor" || posLower === "vice governor") {
            if (candidate.college) {
              const key = `${posLower}_${candidate.college.toLowerCase()}`;
              govPositionsMap[key] = { position: candidate.position, college: candidate.college };
            }
          } else if (posLower === "board member") {
            if (candidate.college && candidate.program) {
              const key = `${posLower}_${candidate.college.toLowerCase()}_${candidate.program.toLowerCase()}`;
              boardPositionsMap[key] = { position: candidate.position, college: candidate.college, program: candidate.program };
            }
          } else {
            generalPositions.add(candidate.position);
          }
        });

        // Helper for creating an abstain candidate object
        const createAbstainCandidate = (idPart, extras = {}) => ({
          _id: "abstain_" + idPart,
          party: "",
          name: "Abstain",
          image: "",
          moreInfo: "Abstain",
          ...extras,
          uniqueId: generateRandomKey(),
        });

        // Add abstain candidate for each general position
        generalPositions.forEach((position) => {
          const idPart = position.replace(/\s+/g, "_").toLowerCase();
          aggregatedCandidates.push(createAbstainCandidate(idPart, { position }));
        });

        // Add abstain candidate for each governor/vice governor (per college)
        Object.values(govPositionsMap).forEach(({ position, college }) => {
          const idPart = `${position.replace(/\s+/g, "_").toLowerCase()}_${college.replace(/\s+/g, "_").toLowerCase()}`;
          aggregatedCandidates.push(createAbstainCandidate(idPart, { position, college }));
        });

        // Add abstain candidate for each board member (per college and program)
        Object.values(boardPositionsMap).forEach(({ position, college, program }) => {
          const idPart = `${position.replace(/\s+/g, "_").toLowerCase()}_${college.replace(/\s+/g, "_").toLowerCase()}_${program.replace(/\s+/g, "_").toLowerCase()}`;
          aggregatedCandidates.push(createAbstainCandidate(idPart, { position, college, program }));
        });

        // Extract candidate unique IDs (assumed to be valid 32-byte hex strings)
        const candidateIds = aggregatedCandidates.map((candidate) => candidate.uniqueId);

        // Reset candidates on blockchain
        const resetTx = await contract.resetCandidates();
        await resetTx.wait();

        // Batch the registration transactions to avoid high fees.
        const BATCH_SIZE = 125; // adjust as needed
        const receipts = [];
        for (let i = 0; i < candidateIds.length; i += BATCH_SIZE) {
          const batch = candidateIds.slice(i, i + BATCH_SIZE);
          // You can add transaction fee overrides here if needed
          const tx = await contract.registerCandidates(batch, {
            // Example fee overrides (adjust to your needs)
            maxFeePerGas: ethers.parseUnits("150", "gwei"),
            maxPriorityFeePerGas: ethers.parseUnits("50", "gwei"),
          });
          const receipt = await tx.wait();
          receipts.push(receipt);
          console.log(`Batch ${i / BATCH_SIZE + 1} registered: ${receipt.hash}`);
        }

        // Update aggregated candidates in the database
        await db.collection("aggregatedCandidates").updateOne({}, { $set: { candidates: aggregatedCandidates } }, { upsert: true });

        // Reset and insert candidate hashes
        await db.collection("candidate_hashes").deleteMany({});
        const candidateHashesDocs = aggregatedCandidates.map((candidate) => ({
          candidateId: candidate.uniqueId,
          emails: [],
        }));
        await db.collection("candidate_hashes").insertMany(candidateHashesDocs);

        // Fetch crypto prices for cost calculation
        const priceData = await getCryptoPrices();
        if (!priceData) console.log("Failed to fetch crypto prices. Skipping cost calculation.");

        // Log blockchain activity for candidate submission
        await recordBlockchainActivity("blockchain_activity_logs", "Candidates Submitted", "Admin", req, receipts, priceData);

        // Aggregate gas costs from each batch
        let totalGasUsed = 0;
        let totalGasPrice = 0;
        receipts.forEach((receipt) => {
          totalGasUsed += Number(receipt.gasUsed);
          totalGasPrice += Number(receipt.gasPrice);
        });
        const candidateCostWei = totalGasUsed * totalGasPrice;
        const candidateCostInPOL = candidateCostWei / 1e18;
        let { ethPricePhp = 0, ethPriceUsd = 0, polPricePhp = 0, polPriceUsd = 0 } = priceData || {};
        if (!polPricePhp && polPriceUsd && ethPricePhp && ethPriceUsd) {
          polPricePhp = (polPriceUsd / ethPriceUsd) * ethPricePhp;
        }
        const candidateCostPHP = polPricePhp ? candidateCostInPOL * polPricePhp : "N/A";
        const candidateCostUSD = polPriceUsd ? candidateCostInPOL * polPriceUsd : "N/A";

        // Build the candidate submission data for blockchain_management
        const candidateSubmissionData = {
          blockchainLink: `https://amoy.polygonscan.com/address/${receipts[0].hash}`, // first batch submission hash
          candidateSubmissionDate: new Date(),
          candidateSubmissionHash: receipts.map((r) => r.hash), // array of hashes from batch submissions
          candidateSubmissionCostGas: totalGasUsed, // stored as a number
          candidateSubmissionCostWei: candidateCostWei,
          candidateSubmissionCostPHP: candidateCostPHP,
          candidateSubmissionCostUSD: candidateCostUSD,
          latestCandidateSubmissionCost: candidateCostInPOL, // cost in POL
        };

        // Update blockchain_management collection:
        // Overwrite the candidate submission data and increment candidateSubmissionsCount and cumulative totals.
        await db.collection("blockchain_management").updateOne(
          {},
          {
            $set: candidateSubmissionData,
            $inc: {
              candidateSubmissionsCount: 1,
              totalGasUsedInCandidates: totalGasUsed,
              totalWeiSpentInCandidates: candidateCostWei,
              totalAmountSpentInCandidatesPol: candidateCostInPOL,
              totalAmountSpentInCandidatesUSD: candidateCostUSD === "N/A" ? 0 : candidateCostUSD,
              totalAmountSpentInCandidatesPHP: candidateCostPHP === "N/A" ? 0 : candidateCostPHP,
            },
          },
          { upsert: true }
        );

        await db.collection("election_config").updateOne({}, { $set: { candidatesSubmitted: true } }, { upsert: true });

        res.status(200).json({
          message: "Candidates submitted to blockchain successfully",
          count: aggregatedCandidates.length,
          blockchainTxReceipts: receipts,
          candidateSubmissionData,
        });
      } catch (error) {
        console.error("Error aggregating candidates:", error);
        res.status(500).json({ error: error.message });
      }
    });

    //test
    const publicAddress = "0xdD70759C1166a90c30C5115Db0188D31B5D331da";

    app.get("/wallet-balance", async (req, res) => {
      try {
        const balanceWei = await provider.getBalance(publicAddress);
        const balancePOL = parseFloat(ethers.formatUnits(balanceWei, 18));

        const prices = await getCryptoPrices();
        if (!prices) {
          return res.status(500).json({ error: "Crypto price data unavailable" });
        }

        // If POL price data is missing, avoid NaN errors
        const balanceUSD = balancePOL * (prices.polPriceUsd || 0);
        const balancePHP = balancePOL * (prices.polPricePhp || 0);
        const balanceETH = balanceUSD / (prices.ethPriceUsd || 1); // Avoid division by 0

        res.status(200).json({
          address: publicAddress,
          balancePOL,
          balanceUSD,
          balancePHP,
          balanceETH,
          updatedAt: new Date(),
        });
      } catch (error) {
        console.error("Error fetching wallet balance:", error.message);
        res.status(500).json({ error: error.message });
      }
    });

    async function initializeNonce() {
      const currentNonce = await provider.getTransactionCount(wallet.address, "latest");
      await db.collection("nonce_counter").updateOne({ wallet: wallet.address }, { $set: { nonce: currentNonce } }, { upsert: true });
      console.log(`Nonce for wallet ${wallet.address} initialized to ${currentNonce}`);
    }

    // Call this after your database connection is established:
    initializeNonce();

    // Global queue to hold vote submission jobs
    const voteQueue = [];
    let processingQueue = false;

    function queueVoteSubmission(job) {
      voteQueue.push(job);
      processQueue();
    }

    async function processQueue() {
      if (processingQueue) return;
      processingQueue = true;
      while (voteQueue.length > 0) {
        const job = voteQueue.shift();
        try {
          await job();
        } catch (error) {
          console.error("Error processing vote job:", error);
        }
      }
      processingQueue = false;
    }

    // POST route: Submits votes to the blockchain
    app.post("/submit-votes-to-blockchain", async (req, res) => {
      try {
        const {
          president,
          vicePresident,
          senator,
          governor,
          viceGovernor,
          boardMember,
          college,
          program,
          email,
          socketId, // optional: if passing socket id from client
        } = req.body;

        // const email = req.user.email;
        console.log("Email from submit votes: ", email);

        // Parse candidate data if sent as JSON strings
        const parsedCandidates = {
          president: typeof president === "string" ? JSON.parse(president) : president,
          vicePresident: typeof vicePresident === "string" ? JSON.parse(vicePresident) : vicePresident,
          senator: typeof senator === "string" ? JSON.parse(senator) : senator,
          governor: typeof governor === "string" ? JSON.parse(governor) : governor,
          viceGovernor: typeof viceGovernor === "string" ? JSON.parse(viceGovernor) : viceGovernor,
          boardMember: typeof boardMember === "string" ? JSON.parse(boardMember) : boardMember,
        };

        let candidateIds = [];
        for (const [key, value] of Object.entries(parsedCandidates)) {
          if (Array.isArray(value)) {
            value.forEach((candidate) => candidateIds.push(candidate.uniqueId));
          } else {
            candidateIds.push(value.uniqueId);
          }
        }
        if (candidateIds.some((id) => id === undefined)) {
          throw new Error("One or more candidate unique IDs are undefined");
        }

        // Hash the email using SHA-256
        // Original line (for production)
        // const hashedEmail = crypto.createHash("sha256").update(email).digest("hex");

        // For testing/development, use a random hex string:
        const hashedEmail = crypto.randomBytes(32).toString("hex");

        // Generate a unique voteId for tracking
        const { v4: uuidv4 } = require("uuid");
        const voteId = uuidv4();

        // Compute queue number: Count all pending votes with createdAt <= now
        const waitingCollection = db.collection("waiting_votes");
        const voteCreatedAt = new Date();
        const pendingCount = await waitingCollection.countDocuments({
          status: "pending",
          createdAt: { $lte: voteCreatedAt },
        });
        const queueNumber = pendingCount + 1;

        // Insert vote details into waiting_votes collection
        await waitingCollection.insertOne({
          voteId,
          candidateIds,
          hashedEmail,
          status: "pending",
          createdAt: voteCreatedAt,
          queueNumber,
          candidates: parsedCandidates, // store candidate objects for later rendering
          voterCollege: college,
          voterProgram: program,
        });

        // Redirect the user to the vote status page.
        res.redirect(`/vote-status?voteId=${voteId}`);

        // Schedule the vote submission job with Agenda.
        // This job will be processed one at a time because of our concurrency setting.
        agenda.now("process vote submission", { voteId, candidateIds, hashedEmail, email, socketId });
      } catch (error) {
        console.error("Error submitting votes to blockchain:", error);
        res.status(500).send("An error occurred while submitting votes.");
      }
    });
    // 2;
    // GET route: Checks vote status and renders appropriate view
    app.get("/vote-status", async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});

        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        const voteId = req.query.voteId;
        if (!voteId) {
          return res.status(400).send("Invalid voteId");
        }

        const waitingCollection = db.collection("waiting_votes");
        const voteRecord = await waitingCollection.findOne({ voteId });
        if (!voteRecord) {
          return res.status(404).send("Vote not found");
        }

        // Ensure candidates is always defined
        const candidates = voteRecord.candidates || {};

        if (voteRecord.status === "pending") {
          return res.render("voter/verify", {
            voterCollege: voteRecord.voterCollege || "Unknown College",
            voterProgram: voteRecord.voterProgram || "Unknown Program",
            voterHash: voteRecord.hashedEmail,
            voteId: voteRecord.voteId,
            electionConfig,
            txHash: voteRecord.txHash || "Reload this page if this is not visible", // ensure txHash is defined
            waiting: true,
            queueNumber: voteRecord.queueNumber,
            candidates,
            email: req.user.email,
          });
        } else if (voteRecord.status === "completed") {
          return res.render("voter/verify", {
            voterCollege: voteRecord.voterCollege || "Unknown College",
            voterProgram: voteRecord.voterProgram || "Unknown Program",
            voterHash: voteRecord.hashedEmail,
            voteId: voteRecord.voteId,
            electionConfig,
            txHash: voteRecord.txHash, // pass the actual txHash
            waiting: false,
            queueNumber: voteRecord.queueNumber,
            candidates,
            email: req.user.email,
          });
        } else if (voteRecord.status === "error") {
          return res.render("voter/verify", {
            error: voteRecord.error,
            waiting: false,
            voterHash: voteRecord.hashedEmail,
            voterCollege: voteRecord.voterCollege || "Unknown College",
            voterProgram: voteRecord.voterProgram || "Unknown Program",
            txHash: null, // include txHash here as well
            candidates,
            email: req.user.email,
            electionConfig,
          });
        }
      } catch (error) {
        console.error("Error retrieving vote status:", error);
        res.status(500).send("An error occurred.");
      }
    });

    const sgMail = require("@sendgrid/mail");
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    /* FOR DESIGNING ONLY */
    app.get("/verify-otp", ensureAuthenticated, async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});
        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);
        const otp = req.query.otp;

        // Automatically accept "999999" for testing
        if (otp === "460825" || otp === "239312" || otp === "175050") {
          req.session.otpVerified = true;
          return res.redirect("/vote?otp_verified=true");
        }

        // Verify the OTP against the one stored in session and ensure it's not expired
        if (!req.session.otp || otp !== req.session.otp || Date.now() > req.session.otpExpires) {
          return res.render("voter/verify-otp", {
            email: req.user.email,
            error: "Check your email for the OTP code.",
            electionConfig,
          });
        }

        req.session.otpVerified = true;
        return res.redirect("/vote?otp_verified=true");
      } catch (error) {
        console.error("Error verifying OTP:", error);
        return res.render("voter/verify-otp", {
          email: req.user.email,
          error: "An error occurred. Please try again.",
          electionConfig,
        });
      }
    });

    app.post("/verify-otp", ensureAuthenticated, async (req, res) => {
      try {
        const { otp } = req.body;

        // Automatically accept "999999" for testing
        if (otp === "460825" || otp === "239312" || otp === "175050") {
          req.session.otpVerified = true;
          return res.redirect("/vote?logged_in=true");
        }

        // Verify the OTP against the one stored in session and ensure it's not expired
        if (!req.session.otp || otp !== req.session.otp || Date.now() > req.session.otpExpires) {
          return res.render("voter/verify-otp", {
            email: req.user.email,
            error: "Invalid or expired OTP.",
          });
        }

        req.session.otpVerified = true;
        return res.redirect("/vote?logged_in=true");
      } catch (error) {
        console.error("Error verifying OTP:", error);
        return res.render("voter/verify-otp", {
          email: req.user.email,
          error: "An error occurred. Please try again.",
        });
      }
    });

    app.post("/request-otp", ensureAuthenticated, async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});
        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        // Generate a new 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        req.session.otp = otp;
        req.session.otpExpires = Date.now() + 5 * 60 * 1000; // Valid for 5 minutes

        // Send the OTP via email using SendGrid
        const msg = {
          to: req.user.email,
          from: process.env.SENDGRID_FROM_EMAIL,
          subject: "Your OTP Code for Voting",
          text: `Your OTP code is ${otp}. It is valid for 5 minutes.`,
        };
        await sgMail.send(msg);

        console.log(`OTP sent to ${req.user.email} - OTP: ${otp}`);

        // Redirect to /verify-otp with a URL param indicating OTP was sent
        return res.redirect("/verify-otp?otp_sent=true");
      } catch (error) {
        console.error("Error sending OTP:", error);
        return res.render("voter/verify-otp", {
          email: req.user.email,
          error: "Failed to send OTP. Please try again.",
          electionConfig,
        });
      }
    });

    app.get("/vote", ensureAuthenticated, async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});
        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        // Check if the voter is registered
        const registeredVoter = await db.collection("registered_voters").findOne({ email: req.user.email });
        if (!registeredVoter) {
          return res.redirect("/?error=not_registered");
        }

        // Hardcode the developer emails (special cases)
        const developerEmails = ["2021100414@ms.bulsu.edu.ph", "2020105248@ms.bulsu.edu.ph", "2021102154@ms.bulsu.edu.ph", "2021100291@ms.bulsu.edu.ph"];
        //"2021108083@ms.bulsu.edu.ph"

        // Check for already voted status only if the dev alert flag isn't present
        if (!req.query.devAlert && registeredVoter.status === "Voted") {
          if (!developerEmails.includes(req.user.email)) {
            return res.redirect("/?error=already_voted");
          } else {
            // For developer accounts, redirect them to /vote with a query param
            // This will only happen on the first request when devAlert is not set.
            return res.redirect("/vote?devAlert=votingAgain");
          }
        }

        // If OTP is not verified, show the verification page with the OTP input
        if (!req.session.otpVerified) {
          return res.render("voter/verify-otp", { email: req.user.email, electionConfig });
        }

        // OTP has been verified—proceed to extract candidate info
        const fullCollege = registeredVoter.college;
        const collegeMatch = fullCollege.match(/\(([^)]+)\)/);
        const college = collegeMatch ? collegeMatch[1] : fullCollege;
        const program = registeredVoter.program;

        const aggregatedDoc = await db.collection("aggregatedCandidates").findOne({});
        const candidates = aggregatedDoc ? aggregatedDoc.candidates : [];

        // Filter candidates for each position
        const presidentCandidates = candidates.filter((candidate) => candidate.position.toLowerCase() === "president");
        const vicePresidentCandidates = candidates.filter((candidate) => candidate.position.toLowerCase() === "vice president");
        const senatorCandidates = candidates.filter((candidate) => candidate.position.toLowerCase() === "senator");
        const governorCandidates = candidates.filter((candidate) => candidate.position.toLowerCase() === "governor" && candidate.college && candidate.college.toLowerCase() === college.toLowerCase());
        const viceGovernorCandidates = candidates.filter((candidate) => candidate.position.toLowerCase() === "vice governor" && candidate.college && candidate.college.toLowerCase() === college.toLowerCase());
        const boardCandidates = candidates.filter((candidate) => candidate.position.toLowerCase() === "board member" && candidate.college && candidate.college.toLowerCase() === college.toLowerCase() && candidate.program && candidate.program.toLowerCase() === program.toLowerCase());

        if (!req.query.logged_in) {
          const separator = req.originalUrl.includes("?") ? "&" : "?";
          return res.redirect(req.originalUrl + separator + "logged_in=true");
        }

        res.render("voter/vote", {
          presidentCandidates,
          vicePresidentCandidates,
          senatorCandidates,
          governorCandidates,
          viceGovernorCandidates,
          boardCandidates,
          college,
          program,
          email: req.user.email,
          electionConfig,
        });
      } catch (error) {
        console.error("Error fetching candidates:", error);
        res.status(500).send("Failed to fetch candidates");
      }
    });

    app.post("/resend-otp", ensureAuthenticated, async (req, res) => {
      try {
        // Generate a new 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        req.session.otp = otp;
        req.session.otpExpires = Date.now() + 5 * 60 * 1000; // 5 minutes expiry

        // Set the dedicated flag indicating an OTP has been requested.
        req.session.otpRequested = true;

        // Send the OTP via email using SendGrid
        const msg = {
          to: req.user.email,
          from: process.env.SENDGRID_FROM_EMAIL,
          subject: "Your OTP Code for Voting (Resent)",
          text: `Your new OTP code is ${otp}. It is valid for 5 minutes.`,
        };
        await sgMail.send(msg);

        // Log OTP re-send details
        console.log(`OTP re-sent to ${req.user.email} - OTP: ${otp}`);

        // Render the OTP entry page with a success message
        return res.render("voter/verify-otp", { email: req.user.email, otpRequested: true, message: "OTP re-sent. Please check your email." });
      } catch (error) {
        console.error("Error resending OTP:", error);
        return res.render("voter/verify-otp", { email: req.user.email, otpRequested: false, error: "Failed to resend OTP. Please try again." });
      }
    });

    // app.get("/verify-otp", async (req, res) => {
    //   res.render("voter/verify-otp");
    // });

    function parseVote(vote, multiple = false) {
      if (Array.isArray(vote)) {
        if (multiple) {
          // Parse every element if multiple votes are allowed.
          return vote.map((v) => {
            try {
              return JSON.parse(v);
            } catch (e) {
              console.error("Error parsing vote element:", v, e);
              return null;
            }
          });
        } else {
          // For single vote groups, parse only the first element.
          try {
            return JSON.parse(vote[0]);
          } catch (e) {
            console.error("Error parsing vote:", vote[0], e);
            return null;
          }
        }
      } else {
        try {
          return JSON.parse(vote);
        } catch (e) {
          console.error("Error parsing vote:", vote, e);
          return null;
        }
      }
    }

    /* for zarina - design */
    app.get("/review", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      // Temporary candidate data in the appropriate format
      const tempData = {
        president: {
          _id: "president_1",
          party: "PEOPLE'S PARTY",
          position: "president",
          name: "John Doe",
          image: "img/candidates/placeholder-1.jpg",
          moreInfo: "A dedicated leader with years of experience in governance.",
          uniqueId: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        },
        vicePresident: {
          _id: "vp_1",
          party: "UNITY PARTY",
          position: "vicePresident",
          name: "Jane Smith",
          image: "img/candidates/placeholder-2.jpg",
          moreInfo: "Advocate for sustainable development and equality.",
          uniqueId: "0x9876543210abcdef9876543210abcdef9876543210abcdef9876543210abcdef",
        },
        senator: [
          {
            _id: "senator_6",
            party: "KASAMA - BulSU",
            position: "senator",
            name: "Patricia V. Garcia",
            image: "img/candidates/placeholder-1.jpg",
            moreInfo: "A philanthropist at heart, with a mission to support underprivileged communities and promote leadership.",
            uniqueId: "0xd72ba5adf3148a908b86811edf0e9d659caf088ec1a5d19f1468b4675bd4ab09",
          },
          {
            _id: "senator_3",
            party: "PROGRESSIVE MOVEMENT",
            position: "senator",
            name: "Robert Brown",
            image: "img/candidates/placeholder-3.jpg",
            moreInfo: "Fighting for workers' rights and fair wages.",
            uniqueId: "0xa1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef",
          },
          {
            _id: "senator_6",
            party: "KASAMA - BulSU",
            position: "senator",
            name: "Patricia V. Garcia",
            image: "img/candidates/placeholder-1.jpg",
            moreInfo: "A philanthropist at heart, with a mission to support underprivileged communities and promote leadership.",
            uniqueId: "0xd72ba5adf3148a908b86811edf0e9d659caf088ec1a5d19f1468b4675bd4ab09",
          },
          {
            _id: "senator_6",
            party: "KASAMA - BulSU",
            position: "senator",
            name: "Patricia V. Garcia",
            image: "img/candidates/placeholder-1.jpg",
            moreInfo: "A philanthropist at heart, with a mission to support underprivileged communities and promote leadership.",
            uniqueId: "0xd72ba5adf3148a908b86811edf0e9d659caf088ec1a5d19f1468b4675bd4ab09",
          },
        ],
        governor: {
          _id: "governor_2",
          party: "UNITY PARTY",
          position: "governor",
          name: "Michael Green",
          image: "img/candidates/placeholder-4.jpg",
          moreInfo: "Focused on infrastructure and community development.",
          uniqueId: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
        },
        viceGovernor: {
          _id: "viceGovernor_1",
          party: "PEOPLE'S PARTY",
          position: "viceGovernor",
          name: "Sarah White",
          image: "img/candidates/placeholder-5.jpg",
          moreInfo: "Committed to education reforms and youth empowerment.",
          uniqueId: "0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        boardMember: {
          _id: "board_1",
          party: "INDEPENDENT",
          position: "boardMember",
          name: "David Black",
          image: "img/candidates/placeholder-6.jpg",
          moreInfo: "Experienced policymaker with a focus on social welfare.",
          uniqueId: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
        },
        college: "Engineering",
        program: "Computer Science",
        email: "example@email.com",
      };

      res.render("voter/review", {
        president: tempData.president,
        vicePresident: tempData.vicePresident,
        senator: tempData.senator, // temporary senator array
        governor: tempData.governor,
        viceGovernor: tempData.viceGovernor,
        boardMember: tempData.boardMember,
        college: tempData.college,
        program: tempData.program,
        email: tempData.email,
        electionConfig,
      });
    });

    app.get("/verify", async (req, res) => {
      try {
        // Retrieve election configuration from the database
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});

        // Use a fake current date if provided; otherwise, use the real current date
        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        // Temporary candidate data
        const tempData = {
          president: {
            _id: "president_1",
            party: "PEOPLE'S PARTY",
            position: "president",
            name: "John Doe",
            image: "img/candidates/placeholder-1.jpg",
            moreInfo: "A dedicated leader with years of experience in governance.",
            uniqueId: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
          },
          vicePresident: {
            _id: "vp_1",
            party: "UNITY PARTY",
            position: "vicePresident",
            name: "Jane Smith",
            image: "img/candidates/placeholder-2.jpg",
            moreInfo: "Advocate for sustainable development and equality.",
            uniqueId: "0x9876543210abcdef9876543210abcdef9876543210abcdef9876543210abcdef",
          },
          senator: [
            {
              _id: "senator_6",
              party: "KASAMA - BulSU",
              position: "senator",
              name: "Patricia V. Garcia",
              image: "img/candidates/placeholder-1.jpg",
              moreInfo: "A philanthropist at heart, with a mission to support underprivileged communities and promote leadership.",
              uniqueId: "0xd72ba5adf3148a908b86811edf0e9d659caf088ec1a5d19f1468b4675bd4ab09",
            },
            {
              _id: "senator_3",
              party: "PROGRESSIVE MOVEMENT",
              position: "senator",
              name: "Robert Brown",
              image: "img/candidates/placeholder-3.jpg",
              moreInfo: "Fighting for workers' rights and fair wages.",
              uniqueId: "0xa1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef",
            },
          ],
          governor: {
            _id: "governor_2",
            party: "UNITY PARTY",
            position: "governor",
            name: "Michael Green",
            image: "img/candidates/placeholder-4.jpg",
            moreInfo: "Focused on infrastructure and community development.",
            uniqueId: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
          },
          viceGovernor: {
            _id: "viceGovernor_1",
            party: "PEOPLE'S PARTY",
            position: "viceGovernor",
            name: "Sarah White",
            image: "img/candidates/placeholder-5.jpg",
            moreInfo: "Committed to education reforms and youth empowerment.",
            uniqueId: "0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          },
          boardMember: {
            _id: "board_1",
            party: "INDEPENDENT",
            position: "boardMember",
            name: "David Black",
            image: "img/candidates/placeholder-6.jpg",
            moreInfo: "Experienced policymaker with a focus on social welfare.",
            uniqueId: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
          },
          voterCollege: "Engineering",
          voterProgram: "Computer Science",
          voterHash: "temporaryhashedemail1234567890abcdef",
          txHash: "0x123abc456def789ghi", // Sample blockchain transaction hash
          email: "test@gmail.com",
        };

        // Group candidate data into one object to match the ejs template
        const candidates = {
          president: tempData.president,
          vicePresident: tempData.vicePresident,
          senator: tempData.senator,
          governor: tempData.governor,
          viceGovernor: tempData.viceGovernor,
          boardMember: tempData.boardMember,
        };

        // Render the verify page with the grouped candidate data and other voter details
        res.render("voter/verify", {
          candidates,
          voterCollege: tempData.voterCollege,
          voterProgram: tempData.voterProgram,
          voterHash: tempData.voterHash,
          txHash: tempData.txHash,
          electionConfig,
          email: tempData.email,
          voteId: "empty",
        });
      } catch (error) {
        console.error("Error rendering verify page:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.post("/review", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      const { president, vicePresident, senator, governor, viceGovernor, boardMember, college, program, email } = req.body;

      console.log("President:", typeof president);
      console.log("Vice President:", typeof vicePresident);
      console.log("Senator:", typeof senator);
      console.log("Governor:", typeof governor);
      console.log("Vice Governor:", typeof viceGovernor);
      console.log("Board Member:", typeof boardMember);

      console.log("Senator:", senator);
      console.log("Parsed Senator:", parseVote(senator, true));

      res.render("voter/review", {
        president: parseVote(president),
        vicePresident: parseVote(vicePresident),
        senator: parseVote(senator, true), // allow multiple votes for senators
        governor: parseVote(governor),
        viceGovernor: parseVote(viceGovernor),
        boardMember: parseVote(boardMember),
        college,
        program,
        email,
        electionConfig,
      });
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

    app.post("/delete-candidate-lsc", async (req, res) => {
      try {
        const { _id, candidatePosition, collegeAcronym, program } = req.body;

        if (!_id || !candidatePosition || !collegeAcronym) {
          return res.status(400).json({ error: "Missing required fields." });
        }

        // Find the college document in the candidates_lsc collection
        const college = await db.collection("candidates_lsc").findOne({ collegeAcronym });
        if (!college) {
          console.log(`❌ College with acronym '${collegeAcronym}' not found.`);
          return res.status(404).json({ error: `College '${collegeAcronym}' not found.` });
        }

        // Find the specific position in the college's positions array
        let positionFound = college.positions.find((pos) => pos.position === candidatePosition);
        if (!positionFound) {
          console.log(`❌ Position '${candidatePosition}' not found.`);
          return res.status(404).json({ error: `Position '${candidatePosition}' not found.` });
        }

        let deleted = false;

        // If the candidate is a Board Member and a program is specified, search within the program array
        if (candidatePosition === "Board Member" && program) {
          if (!positionFound.programs) {
            console.log(`❌ No programs data available for Board Member in college '${collegeAcronym}'.`);
            return res.status(404).json({ error: `No program data for Board Member in college '${collegeAcronym}'.` });
          }

          let programFound = positionFound.programs.find((prog) => prog.program === program);
          if (!programFound) {
            console.log(`❌ Program '${program}' not found in Board Member.`);
            return res.status(404).json({ error: `Program '${program}' not found.` });
          }

          const originalLength = programFound.candidates.length;
          programFound.candidates = programFound.candidates.filter((candidate) => candidate._id !== _id);

          if (programFound.candidates.length < originalLength) {
            deleted = true;
          }
        } else {
          // For positions other than Board Member or if no program is specified
          const originalLength = positionFound.candidates.length;
          positionFound.candidates = positionFound.candidates.filter((candidate) => candidate._id !== _id);

          if (positionFound.candidates.length < originalLength) {
            deleted = true;
          }
        }

        if (!deleted) {
          console.log(`❌ Candidate with ID '${_id}' not found.`);
          return res.status(404).json({ error: "Candidate not found." });
        }

        // Update the document with the modified positions array
        await db.collection("candidates_lsc").updateOne({ collegeAcronym }, { $set: { positions: college.positions } });

        console.log(`Candidate with ID ${_id} deleted successfully.`);
        res.status(200).json({ message: `Candidate with ID '${_id}' deleted successfully.` });
      } catch (error) {
        console.error("❌ Error deleting candidate in LSC:", error);
        res.status(500).json({ error: "Internal server error." });
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

        await logActivity("system_activity_logs", "Candidate Updated", "Admin", req);

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

        await logActivity("system_activity_logs", "Candidate Added", "Admin", req);

        if (result.modifiedCount > 0) {
          console.log(`Candidate ${name} added successfully.`);
          res.redirect("/candidates");
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
        res.redirect("/candidates");
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

      // Compute totals from listOfElections, if available
      let totalRegisteredVoters = 0;
      let totalVoted = 0;
      let totalVoters = 0;
      if (electionConfig.listOfElections && Array.isArray(electionConfig.listOfElections)) {
        electionConfig.listOfElections.forEach((college) => {
          totalRegisteredVoters += college.registeredVoters;
          totalVoted += college.numberOfVoted;
          totalVoters += college.voters;
        });
      }
      // Calculate voter turnout percentage (avoid division by zero)
      let turnoutPercentage = totalVoters > 0 ? (totalVoted / totalVoters) * 100 : 0;

      // Get the latest blockchainInfo document (for transaction hash and submission date).
      const blockchainInfo = (await db.collection("blockchainInfo").findOne({})) || null;

      // Get blockchain management totals from blockchain_management collection.
      const blockchainMgmt = (await db.collection("blockchain_management").findOne({})) || null;

      // ----- Get Wallet Info -----
      const balanceWei = await provider.getBalance(publicAddress);
      const balancePOL = parseFloat(ethers.formatUnits(balanceWei, 18));

      // Fetch prices using polygon-ecosystem-token.
      const prices = await getCryptoPrices();
      // Calculate wallet equivalents in USD and PHP.
      const balanceUSD = balancePOL * (prices?.polPriceUsd || 0);
      const balancePHP = balancePOL * (prices?.polPricePhp || 0);

      const walletInfo = {
        address: publicAddress,
        balancePOL,
        balanceUSD,
        balancePHP,
        updatedAt: new Date(),
      };

      // const totalCandidates = await db.collection("blockchain_candidates").countDocuments({});
      // Update totalCandidates in electionConfig by counting documents in blockchain_candidates collection
      electionConfig.totalCandidates = await db.collection("blockchain_candidates").countDocuments({});

      console.log(electionConfig);
      res.render("admin/dashboard", {
        electionConfig,
        loggedInAdmin: req.session.admin,
        totalRegisteredVoters,
        turnoutPercentage,
        moment,
        blockchainInfo,
        blockchainMgmt,
        walletInfo,
        // totalCandidates,
      });
    });

    // export quick actions

    // Make sure you have imported any required modules at the top of your file, e.g.,
    // const { Parser } = require("json2csv");
    // Also, ensure you have your MongoDB connection available as `db`

    app.get("/api/export/:type/:format", async (req, res) => {
      try {
        const { type, format } = req.params;

        // Validate the requested format
        if (!["json", "csv"].includes(format)) {
          return res.status(400).send("Invalid format requested");
        }

        // Determine which collections to export and the filename suffix based on the type parameter
        let collectionsToExport = [];
        let filenameSuffix = "";

        switch (type) {
          case "voter-info": // also accepts "voters" if you wish
            collectionsToExport = ["registered_voters"];
            filenameSuffix = "registered_voters";
            break;
          case "results":
            collectionsToExport = ["results"];
            filenameSuffix = "results";
            break;
          case "vote-tally":
            collectionsToExport = ["vote_tally"];
            filenameSuffix = "vote_tally";
            break;
          case "candidates":
            // Export both candidates collections
            collectionsToExport = ["candidates", "candidates_lsc"];
            filenameSuffix = "candidates";
            break;
          case "admin-accounts":
            // Only allow developers to export admin accounts
            if (!req.session.admin || req.session.admin.role !== "Developer") {
              return res.status(403).send("Unauthorized to export admin accounts");
            }
            collectionsToExport = ["admin_accounts"];
            filenameSuffix = "admin_accounts";
            break;
          default:
            return res.status(400).send("Invalid export type requested");
        }

        // Initialize an empty array to collect data from each collection
        let data = [];

        // Loop over the collections to export and combine their documents
        for (let collectionName of collectionsToExport) {
          const collectionData = await db.collection(collectionName).find({}).toArray();
          data = data.concat(collectionData);
        }

        // Send the response in the requested format
        if (format === "json") {
          res.setHeader("Content-Disposition", `attachment; filename=export_${filenameSuffix}.json`);
          res.setHeader("Content-Type", "application/json");
          return res.send(JSON.stringify(data, null, 2));
        } else {
          // Ensure the data is an array; if not, wrap it in one.
          const dataArray = Array.isArray(data) ? data : [data];

          // If there's no data, send an empty CSV file
          if (dataArray.length === 0) {
            res.setHeader("Content-Disposition", `attachment; filename=export_${filenameSuffix}.csv`);
            res.setHeader("Content-Type", "text/csv");
            return res.send("");
          }

          try {
            const json2csvParser = new Parser();
            const csv = json2csvParser.parse(dataArray);
            res.setHeader("Content-Disposition", `attachment; filename=export_${filenameSuffix}.csv`);
            res.setHeader("Content-Type", "text/csv");
            return res.send(csv);
          } catch (csvError) {
            console.error("CSV conversion error:", csvError);
            return res.status(500).send("Error converting data to CSV");
          }
        }
      } catch (error) {
        console.error("Export error:", error);
        return res.status(500).send("Internal Server Error");
      }
    });

    const moment = require("moment-timezone");

    // GET /configuration
    app.get("/configuration", ensureAdminAuthenticated, async (req, res) => {
      let electionConfig = await db.collection("election_config").findOne({});

      // Check if fakeCurrentDate exists, otherwise use the current date
      // const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();

      // electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      // Set simulatedDate to null if fakeCurrentDate doesn't exist
      // const simulatedDate = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate).toISOString() : null;

      res.render("admin/configuration", { electionConfig, loggedInAdmin: req.session.admin, moment });
    });

    // POST endpoint to save election configuration
    app.post("/configuration", async (req, res) => {
      try {
        // Destructure form data
        const {
          electionName,
          registrationStart,
          registrationEnd,
          votingStart,
          votingEnd,
          partylists,
          colleges, // Object: { CAFA: "value", CAL: "value", ... }
        } = req.body;

        // Process the comma-separated party list into an array
        const partylistsArray = partylists.split(",").map((item) => item.trim());

        // Fixed mapping for the 13 colleges
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

        // Create the colleges array using the fixed mapping.
        // For each college, the value from the form (if any) will be used as the 'notRegisteredNotVoted' count.
        let collegesArray = [];
        for (const acronym in collegeMapping) {
          const count = colleges && colleges[acronym] ? parseInt(colleges[acronym], 10) : 0;
          collegesArray.push({
            acronym: acronym,
            name: collegeMapping[acronym],
            numberOfStudents: count,
            notRegisteredNotVoted: count,
            registeredNotVoted: 0,
            registeredVoted: 0,
          });
        }

        // Build the new configuration object.
        const update = {
          electionStatus: "ELECTION ACTIVE", // Immediately active when saved.
          specialStatus: "None",
          electionName,
          registrationStart: registrationStart ? moment.tz(registrationStart, "Asia/Manila").toDate() : null,
          registrationEnd: registrationEnd ? moment.tz(registrationEnd, "Asia/Manila").toDate() : null,
          votingStart: votingStart ? moment.tz(votingStart, "Asia/Manila").toDate() : null,
          votingEnd: votingEnd ? moment.tz(votingEnd, "Asia/Manila").toDate() : null,
          partylists: partylistsArray,
          colleges: collegesArray,
          updatedAt: new Date(),
        };

        // Calculate totals from the collegesArray
        update.totalNumberOfStudents = collegesArray.reduce((total, college) => total + college.numberOfStudents, 0);
        update.totalNotRegisteredNotVoted = collegesArray.reduce((total, college) => total + college.notRegisteredNotVoted, 0);
        update.totalRegisteredNotVoted = collegesArray.reduce((total, college) => total + college.registeredNotVoted, 0);
        update.totalRegisteredVoted = collegesArray.reduce((total, college) => total + college.registeredVoted, 0);

        // Instead of this conditional check:
        // const existingConfig = await db.collection("election_config").findOne({});
        // if (!existingConfig || !existingConfig.fakeCurrentDate) {
        //   update.fakeCurrentDate = new Date();
        // }

        // Set fakeCurrentDate to the current date unconditionally:
        update.fakeCurrentDate = new Date();

        // Overwrite the existing election configuration (upsert if not exists)
        await db.collection("election_config").updateOne({}, { $set: update, $setOnInsert: { createdAt: new Date() } }, { upsert: true });

        // Log the activity (assuming a logActivity function exists)
        await logActivity("system_activity_logs", "Election Configuration Saved", "Admin", req);
        console.log("Saved Election Configuration:", update);

        res.redirect("configuration?saved=true");
      } catch (error) {
        console.error("Error updating election configuration:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.post("/update-special-status", async (req, res) => {
      try {
        // Get the new specialStatus from the form.
        const { specialStatus } = req.body;

        // Update the specialStatus field in the election_config collection.
        // This assumes there is a single configuration document.
        await db.collection("election_config").updateOne({}, { $set: { specialStatus } });

        // Optionally, log the activity if you have a logging function.
        await logActivity("system_activity_logs", `Special Status Updated to: ${specialStatus}`, "Admin", req);

        // Redirect back to the referring page or to /configuration.
        res.redirect(req.get("referer") || "/configuration");
      } catch (error) {
        console.error("Error updating specialStatus:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.post("/update-fake-date", async (req, res) => {
      try {
        const { fakeCurrentDate } = req.body;
        console.log("Update fake date called:", fakeCurrentDate);
        const newDate = moment.tz(fakeCurrentDate, "Asia/Manila").toDate();
        await db.collection("election_config").updateOne({}, { $set: { fakeCurrentDate: newDate } });
        res.redirect("/configuration");
      } catch (err) {
        console.error("Error updating fake current date", err);
        res.status(500).send("Internal Server Error");
      }
    });

    app.post("/toggle-date-mode", async (req, res) => {
      try {
        // If the checkbox is checked, req.body.useFakeDate will be "true".
        // If unchecked, the value may be undefined, so we default to false.
        const useFakeDate = req.body.useFakeDate === "true" ? true : false;
        console.log("Toggle date mode called:", useFakeDate);

        await db.collection("election_config").updateOne({}, { $set: { useFakeDate: useFakeDate } });
        res.redirect("/configuration");
      } catch (err) {
        console.error("Error updating date mode", err);
        res.status(500).send("Internal Server Error");
      }
    });

    app.post("/update-candidates-submitted", async (req, res) => {
      try {
        const { candidatesSubmitted } = req.body;
        console.log("Update candidatesSubmitted called:", candidatesSubmitted);
        // Convert the string value to a boolean.
        const submitted = candidatesSubmitted === "true";
        // Update the election_config document (using an empty filter if you're updating the single config document)
        await db.collection("election_config").updateOne({}, { $set: { candidatesSubmitted: submitted } });
        res.redirect("/configuration");
      } catch (err) {
        console.error("Error updating candidatesSubmitted", err);
        res.status(500).send("Internal Server Error");
      }
    });

    function recalculatePeriodUsing(testDate, electionConfig) {
      // Helper to extract a Date from a field that might be a Date string or an object with a "$date" property.
      const getDate = (dateField) => {
        if (dateField && typeof dateField === "object" && dateField.$date) {
          return new Date(dateField.$date);
        }
        return new Date(dateField);
      };

      // Ensure all required dates exist
      if (!electionConfig.registrationStart || !electionConfig.registrationEnd || !electionConfig.votingStart || !electionConfig.votingEnd) {
        return { name: "Election Not Active", duration: "Configuration Incomplete", waitingFor: null };
      }

      // Convert stored dates to Date objects
      const regStart = getDate(electionConfig.registrationStart);
      const regEnd = getDate(electionConfig.registrationEnd);
      const voteStart = getDate(electionConfig.votingStart);
      const voteEnd = getDate(electionConfig.votingEnd);

      if (testDate < regStart) {
        return {
          name: "Waiting for Registration Period",
          duration: `${testDate.toLocaleString()} to ${regStart.toLocaleString()}`,
          waitingFor: "Registration",
        };
      } else if (testDate >= regStart && testDate <= regEnd) {
        return {
          name: "Registration Period",
          duration: `${regStart.toLocaleString()} to ${regEnd.toLocaleString()}`,
        };
      } else if (testDate > regEnd && testDate < voteStart) {
        return {
          name: "Waiting for Voting Period",
          duration: `${regEnd.toLocaleString()} to ${voteStart.toLocaleString()}`,
          waitingFor: "Voting",
        };
      } else if (testDate >= voteStart && testDate <= voteEnd) {
        return {
          name: "Voting Period",
          duration: `${voteStart.toLocaleString()} to ${voteEnd.toLocaleString()}`,
        };
      } else if (testDate > voteEnd) {
        if (electionConfig.electionStatus === "Results Are Out") {
          return {
            name: "Results Are Out Period",
            duration: `${voteEnd.toLocaleString()} to (manual)`,
          };
        } else {
          return {
            name: "Results Double Checking Period",
            duration: `${voteEnd.toLocaleString()} to (manual trigger)`,
          };
        }
      }
      return { name: "Election Not Active", duration: "N/A" };
    }

    // POST /set-test-date (update fake current date and current phase)
    app.post("/set-test-date", async (req, res) => {
      try {
        const { fakeCurrentDate } = req.body;
        const testDate = new Date(fakeCurrentDate);

        // Retrieve the current election configuration from the DB
        const electionConfig = await db.collection("election_config").findOne({ _id: "election_config" });

        // Recalculate the period based on the new fake current date
        const period = recalculatePeriodUsing(testDate, electionConfig);

        // Update the document with the new fakeCurrentDate and recalculated period
        const result = await db.collection("election_config").updateOne({ _id: "election_config" }, { $set: { fakeCurrentDate, currentPeriod: period, updatedAt: new Date() } }, { upsert: true });

        res.json({ success: true, fakeCurrentDate, period });
      } catch (error) {
        console.error("Error setting fake current date:", error);
        res.status(500).json({ success: false });
      }
    });

    app.post("/temporarily-closed", async (req, res) => {
      try {
        await db.collection("election_config").updateOne({}, { $set: { specialStatus: "System Temporarily Closed" } });
        res.redirect("/dashboard"); // Redirect to the homepage or appropriate route
      } catch (error) {
        console.error("Error closing election:", error);
        res.status(500).send("Error updating election configuration");
      }
    });

    app.post("/resume-election", async (req, res) => {
      try {
        await db.collection("election_config").updateOne({}, { $set: { specialStatus: "None" } });
        res.redirect("/dashboard"); // Redirect to the homepage or appropriate route
      } catch (error) {
        console.error("Error resuming election:", error);
        res.status(500).send("Error updating election configuration");
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
          moment,
        });
      } catch (error) {
        console.error("Error fetching candidates for dashboard:", error);
        res.status(500).send("Failed to fetch candidates data for the dashboard");
      }
    });

    app.get("/old-candidates", ensureAdminAuthenticated, async (req, res) => {
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

        res.render("admin/old-candidates", {
          candidates: allCandidates,
          candidates_lsc: structuredData,
          voterCounts,
          electionConfig,
          loggedInAdmin: req.session.admin,
          moment,
        });
      } catch (error) {
        console.error("Error fetching candidates for dashboard:", error);
        res.status(500).send("Failed to fetch candidates data for the dashboard");
      }
    });

    app.get("/blockchain-management", ensureAdminAuthenticated, async (req, res) => {
      try {
        // Fetch election configuration.
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});
        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        // ----- Get Wallet Info -----
        const balanceWei = await provider.getBalance(publicAddress);
        const balancePOL = parseFloat(ethers.formatUnits(balanceWei, 18));

        // Fetch prices using polygon-ecosystem-token.
        const prices = await getCryptoPrices();
        // Calculate wallet equivalents in USD and PHP.
        const balanceUSD = balancePOL * (prices?.polPriceUsd || 0);
        const balancePHP = balancePOL * (prices?.polPricePhp || 0);

        const walletInfo = {
          address: publicAddress,
          balancePOL,
          balanceUSD,
          balancePHP,
          updatedAt: new Date(),
        };

        // ----- Get Blockchain Transaction Info -----
        // Get the latest blockchainInfo document (for transaction hash and submission date).
        const blockchainInfo = (await db.collection("blockchainInfo").findOne({})) || null;

        // Get blockchain management totals from blockchain_management collection.
        const blockchainMgmt = (await db.collection("blockchain_management").findOne({})) || null;

        // ----- Get Candidate Submission Status -----
        const systemStatus = await db.collection("system_status").findOne({ _id: "candidate_submission" });
        const candidateSubmission = systemStatus ? systemStatus.submitted : false;

        res.render("admin/blockchain-management", {
          electionConfig,
          loggedInAdmin: req.session.admin,
          walletInfo,
          blockchainInfo, // Latest transaction info (hash, date)
          blockchainMgmt, // Totals and counts (candidateSubmissionsCount, voteTransactionsCount, totals, etc.)
          candidateSubmission,
          moment,
        });
      } catch (error) {
        console.error("Error in blockchain management route:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // Inline function to record blockchain activity with cost details

    app.get("/blockchain-activity-log", ensureAdminAuthenticated, async (req, res) => {
      try {
        // Retrieve logs sorted by most recent first
        const logs = await db.collection("blockchain_activity_logs").find({}).sort({ timestamp: -1 }).toArray();

        // Retrieve election configuration (if needed)
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});
        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        // Render the blockchain activity log page
        res.render("admin/blockchain-activity-log", {
          electionConfig,
          logs,
          loggedInAdmin: req.session.admin,
          moment,
        });
      } catch (error) {
        console.error("Error fetching blockchain logs:", error);
        res.status(500).send("Error fetching blockchain logs.");
      }
    });

    app.get("/voter-info", ensureAdminAuthenticated, async (req, res) => {
      try {
        const voters = await db.collection("registered_voters").find().toArray();

        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});

        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        res.render("admin/election-voter-info", { voters, electionConfig, loggedInAdmin: req.session.admin, moment }); // Pass voters to EJS template
      } catch (error) {
        console.error("Error fetching registered voters:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    // app.get("/voter-turnout", ensureAdminAuthenticated, async (req, res) => {
    //   try {
    //     const electionConfigCollection = db.collection("election_config");
    //     let electionConfig = await electionConfigCollection.findOne({});

    //     // Calculate overall totals from the registered_voters collection
    //     const votersCollection = db.collection("registered_voters");
    //     const totalRegistered = await votersCollection.countDocuments({});
    //     const totalVoted = await votersCollection.countDocuments({ status: "Voted" });
    //     const totalNotVoted = await votersCollection.countDocuments({ status: "Registered" });

    //     // Log the overall turnout counts to the console
    //     console.log("Voter Turnout:");
    //     console.log("Total Registered:", totalRegistered);
    //     console.log("Total Voted:", totalVoted);
    //     console.log("Total Not Voted:", totalNotVoted);

    //     // Add these overall totals to electionConfig and update the document
    //     electionConfig.totalRegistered = totalRegistered;
    //     electionConfig.totalVoted = totalVoted;
    //     electionConfig.totalNotVoted = totalNotVoted;

    //     await electionConfigCollection.updateOne({ _id: electionConfig._id }, { $set: { totalRegistered, totalVoted, totalNotVoted } });

    //     // Aggregate counts per college from the registered_voters collection.
    //     // Each group’s _id will be the college string (e.g., "College of Architecture and Fine Arts (CAFA)")
    //     // and we sum the total number of documents and count how many voted.
    //     const collegeAggregation = await votersCollection
    //       .aggregate([
    //         {
    //           $group: {
    //             _id: "$college",
    //             registered: { $sum: 1 },
    //             voted: { $sum: { $cond: [{ $eq: ["$status", "Voted"] }, 1, 0] } },
    //           },
    //         },
    //       ])
    //       .toArray();

    //     // Update each college in electionConfig.listOfElections.
    //     // We match based on the acronym. The registered_voters documents store college as something like
    //     // "College of Architecture and Fine Arts (CAFA)"; we extract the acronym using regex.
    //     electionConfig.listOfElections.forEach((collegeObj) => {
    //       // Find the aggregation result whose _id contains the same acronym as collegeObj.acronym
    //       const group = collegeAggregation.find((g) => {
    //         const match = g._id.match(/\(([^)]+)\)/);
    //         return match && match[1] === collegeObj.acronym;
    //       });
    //       if (group) {
    //         collegeObj.registeredVoters = group.registered;
    //         collegeObj.numberOfVoted = group.voted;
    //         // Update "students" as well; here we set it equal to the total registered in that college.
    //         // Adjust this logic if "students" should be a fixed capacity.
    //         collegeObj.students = group.registered;
    //       }
    //     });

    //     // Optionally update the election_config document with the updated listOfElections array
    //     await electionConfigCollection.updateOne({ _id: electionConfig._id }, { $set: { listOfElections: electionConfig.listOfElections } });

    //     const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
    //     electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

    //     res.render("admin/election-voter-turnout", { electionConfig, loggedInAdmin: req.session.admin });
    //   } catch (error) {
    //     console.error("Error fetching voter turnout:", error);
    //     res.status(500).send("Server error while fetching voter turnout");
    //   }
    // });

    app.get("/voter-turnout", ensureAdminAuthenticated, async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});

        const votersCollection = db.collection("registered_voters");

        // Aggregate counts for "Registered" and "Voted" statuses per college
        const collegeRegisteredAggregation = await votersCollection
          .aggregate([
            {
              $group: {
                _id: "$college",
                count: {
                  $sum: { $cond: [{ $eq: ["$status", "Registered"] }, 1, 0] },
                },
              },
            },
          ])
          .toArray();

        const collegeVotedAggregation = await votersCollection
          .aggregate([
            {
              $group: {
                _id: "$college",
                count: {
                  $sum: { $cond: [{ $eq: ["$status", "Voted"] }, 1, 0] },
                },
              },
            },
          ])
          .toArray();

        // Update each college object in electionConfig.colleges
        electionConfig.colleges.forEach((collegeObj) => {
          // The registered_voters document's college field is a string like "College of Arts and Letters (CAL)".
          // Extract the acronym using regex.
          const regGroup = collegeRegisteredAggregation.find((g) => {
            const match = g._id.match(/\(([^)]+)\)/);
            return match && match[1] === collegeObj.acronym;
          });
          const votedGroup = collegeVotedAggregation.find((g) => {
            const match = g._id.match(/\(([^)]+)\)/);
            return match && match[1] === collegeObj.acronym;
          });
          // Set counts (defaulting to 0 if not found)
          collegeObj.registeredNotVoted = regGroup ? regGroup.count : 0;
          collegeObj.registeredVoted = votedGroup ? votedGroup.count : 0;
          // Calculate notRegisteredNotVoted so that the sum equals numberOfStudents
          collegeObj.notRegisteredNotVoted = collegeObj.numberOfStudents - (collegeObj.registeredNotVoted + collegeObj.registeredVoted);
        });

        // Calculate overall totals by summing across all colleges
        let totalNumberOfStudents = 0;
        let totalNotRegisteredNotVoted = 0;
        let totalRegisteredNotVoted = 0;
        let totalRegisteredVoted = 0;

        electionConfig.colleges.forEach((collegeObj) => {
          totalNumberOfStudents += collegeObj.numberOfStudents;
          totalNotRegisteredNotVoted += collegeObj.notRegisteredNotVoted;
          totalRegisteredNotVoted += collegeObj.registeredNotVoted;
          totalRegisteredVoted += collegeObj.registeredVoted;
        });

        // Update the overall totals in electionConfig
        electionConfig.totalNumberOfStudents = totalNumberOfStudents;
        electionConfig.totalNotRegisteredNotVoted = totalNotRegisteredNotVoted;
        electionConfig.totalRegisteredNotVoted = totalRegisteredNotVoted;
        electionConfig.totalRegisteredVoted = totalRegisteredVoted;

        // Save updated college data and totals back to the database
        await electionConfigCollection.updateOne(
          { _id: electionConfig._id },
          {
            $set: {
              colleges: electionConfig.colleges,
              totalNumberOfStudents,
              totalNotRegisteredNotVoted,
              totalRegisteredNotVoted,
              totalRegisteredVoted,
            },
          }
        );

        // Determine the current period using fakeCurrentDate if enabled
        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        res.render("admin/election-voter-turnout", {
          electionConfig,
          loggedInAdmin: req.session.admin,
          moment,
        });
      } catch (error) {
        console.error("Error fetching voter turnout:", error);
        res.status(500).send("Server error while fetching voter turnout");
      }
    });

    // app.post("/voter-turnout/save", ensureAdminAuthenticated, async (req, res) => {
    //   try {
    //     const electionConfigCollection = db.collection("election_config");
    //     let electionConfig = await electionConfigCollection.findOne({});

    //     const votersCollection = db.collection("registered_voters");

    //     // Aggregate counts for "Registered" and "Voted" statuses per college
    //     const collegeRegisteredAggregation = await votersCollection
    //       .aggregate([
    //         {
    //           $group: {
    //             _id: "$college",
    //             count: {
    //               $sum: { $cond: [{ $eq: ["$status", "Registered"] }, 1, 0] },
    //             },
    //           },
    //         },
    //       ])
    //       .toArray();

    //     const collegeVotedAggregation = await votersCollection
    //       .aggregate([
    //         {
    //           $group: {
    //             _id: "$college",
    //             count: {
    //               $sum: { $cond: [{ $eq: ["$status", "Voted"] }, 1, 0] },
    //             },
    //           },
    //         },
    //       ])
    //       .toArray();

    //     // Update each college object in electionConfig.colleges with computed values
    //     electionConfig.colleges.forEach((collegeObj) => {
    //       // Extract acronym from the registered_voters college field
    //       const regGroup = collegeRegisteredAggregation.find((g) => {
    //         const match = g._id.match(/\(([^)]+)\)/);
    //         return match && match[1] === collegeObj.acronym;
    //       });
    //       const votedGroup = collegeVotedAggregation.find((g) => {
    //         const match = g._id.match(/\(([^)]+)\)/);
    //         return match && match[1] === collegeObj.acronym;
    //       });
    //       collegeObj.registeredNotVoted = regGroup ? regGroup.count : 0;
    //       collegeObj.registeredVoted = votedGroup ? votedGroup.count : 0;
    //       collegeObj.notRegisteredNotVoted = collegeObj.numberOfStudents - (collegeObj.registeredNotVoted + collegeObj.registeredVoted);
    //     });

    //     // Calculate overall totals
    //     let totalNumberOfStudents = 0;
    //     let totalNotRegisteredNotVoted = 0;
    //     let totalRegisteredNotVoted = 0;
    //     let totalRegisteredVoted = 0;

    //     electionConfig.colleges.forEach((collegeObj) => {
    //       totalNumberOfStudents += collegeObj.numberOfStudents;
    //       totalNotRegisteredNotVoted += collegeObj.notRegisteredNotVoted;
    //       totalRegisteredNotVoted += collegeObj.registeredNotVoted;
    //       totalRegisteredVoted += collegeObj.registeredVoted;
    //     });

    //     // Update overall totals in electionConfig
    //     electionConfig.totalNumberOfStudents = totalNumberOfStudents;
    //     electionConfig.totalNotRegisteredNotVoted = totalNotRegisteredNotVoted;
    //     electionConfig.totalRegisteredNotVoted = totalRegisteredNotVoted;
    //     electionConfig.totalRegisteredVoted = totalRegisteredVoted;

    //     // Determine the current period using fakeCurrentDate if enabled
    //     const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
    //     electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

    //     // Prepare the document to be stored in voter_turnout collection.
    //     // Optionally, you might want to remove any properties (like _id) that you don't want to persist.
    //     const voterTurnoutData = {
    //       timestamp: new Date(),
    //       data: electionConfig, // storing the computed election configuration
    //     };

    //     // Save the computed turnout data into the "voter_turnout" collection
    //     const voterTurnoutCollection = db.collection("voter_turnout");
    //     await voterTurnoutCollection.insertOne(voterTurnoutData);

    //     res.send("Voter turnout data saved successfully.");
    //   } catch (error) {
    //     console.error("Error saving voter turnout data:", error);
    //     res.status(500).send("Server error while saving voter turnout data");
    //   }
    // });

    app.get("/voter-turnout/save", ensureAdminAuthenticated, async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});

        const votersCollection = db.collection("registered_voters");

        // Aggregate counts for "Registered" statuses per college
        const collegeRegisteredAggregation = await votersCollection
          .aggregate([
            {
              $group: {
                _id: "$college",
                count: {
                  $sum: { $cond: [{ $eq: ["$status", "Registered"] }, 1, 0] },
                },
              },
            },
          ])
          .toArray();

        // Aggregate counts for "Voted" statuses per college
        const collegeVotedAggregation = await votersCollection
          .aggregate([
            {
              $group: {
                _id: "$college",
                count: {
                  $sum: { $cond: [{ $eq: ["$status", "Voted"] }, 1, 0] },
                },
              },
            },
          ])
          .toArray();

        // Update each college object in electionConfig.colleges with computed values and percentages
        electionConfig.colleges.forEach((collegeObj) => {
          // Extract acronym from the registered_voters college field using regex.
          const regGroup = collegeRegisteredAggregation.find((g) => {
            const match = g._id.match(/\(([^)]+)\)/);
            return match && match[1] === collegeObj.acronym;
          });
          const votedGroup = collegeVotedAggregation.find((g) => {
            const match = g._id.match(/\(([^)]+)\)/);
            return match && match[1] === collegeObj.acronym;
          });

          collegeObj.registeredNotVoted = regGroup ? regGroup.count : 0;
          collegeObj.registeredVoted = votedGroup ? votedGroup.count : 0;
          collegeObj.notRegisteredNotVoted = collegeObj.numberOfStudents - (collegeObj.registeredNotVoted + collegeObj.registeredVoted);

          // Compute the turnout percentage for the college
          collegeObj.voterTurnoutPercentage = collegeObj.numberOfStudents > 0 ? ((collegeObj.registeredVoted / collegeObj.numberOfStudents) * 100).toFixed(2) : "0.00";
        });

        // Calculate overall totals
        let totalNumberOfStudents = 0;
        let totalRegisteredVoted = 0;

        electionConfig.colleges.forEach((collegeObj) => {
          totalNumberOfStudents += collegeObj.numberOfStudents;
          totalRegisteredVoted += collegeObj.registeredVoted;
        });

        // Update overall totals and overall turnout percentage in electionConfig
        electionConfig.totalNumberOfStudents = totalNumberOfStudents;
        electionConfig.totalRegisteredVoted = totalRegisteredVoted;
        electionConfig.overallVoterTurnoutPercentage = totalNumberOfStudents > 0 ? ((totalRegisteredVoted / totalNumberOfStudents) * 100).toFixed(2) : "0.00";

        // Determine the current period using fakeCurrentDate if enabled
        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        // Prepare the document to be stored
        const voterTurnoutData = {
          timestamp: new Date(),
          data: electionConfig,
        };

        // Save the computed data into the "voter_turnout" collection
        const voterTurnoutCollection = db.collection("voter_turnout");
        await voterTurnoutCollection.insertOne(voterTurnoutData);

        res.send("Voter turnout data saved successfully.");
      } catch (error) {
        console.error("Error saving voter turnout data:", error);
        res.status(500).send("Server error while saving voter turnout data");
      }
    });

    app.get("/rvs-voter-turnout", async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});

        const votersCollection = db.collection("registered_voters");

        // Aggregate counts for "Registered" and "Voted" statuses per college
        const collegeRegisteredAggregation = await votersCollection
          .aggregate([
            {
              $group: {
                _id: "$college",
                count: {
                  $sum: { $cond: [{ $eq: ["$status", "Registered"] }, 1, 0] },
                },
              },
            },
          ])
          .toArray();

        const collegeVotedAggregation = await votersCollection
          .aggregate([
            {
              $group: {
                _id: "$college",
                count: {
                  $sum: { $cond: [{ $eq: ["$status", "Voted"] }, 1, 0] },
                },
              },
            },
          ])
          .toArray();

        // Update each college object in electionConfig.colleges
        electionConfig.colleges.forEach((collegeObj) => {
          // The registered_voters document's college field is a string like "College of Arts and Letters (CAL)".
          // Extract the acronym using regex.
          const regGroup = collegeRegisteredAggregation.find((g) => {
            const match = g._id.match(/\(([^)]+)\)/);
            return match && match[1] === collegeObj.acronym;
          });
          const votedGroup = collegeVotedAggregation.find((g) => {
            const match = g._id.match(/\(([^)]+)\)/);
            return match && match[1] === collegeObj.acronym;
          });
          // Set counts (defaulting to 0 if not found)
          collegeObj.registeredNotVoted = regGroup ? regGroup.count : 0;
          collegeObj.registeredVoted = votedGroup ? votedGroup.count : 0;
          // Calculate notRegisteredNotVoted so that the sum equals numberOfStudents
          collegeObj.notRegisteredNotVoted = collegeObj.numberOfStudents - (collegeObj.registeredNotVoted + collegeObj.registeredVoted);
        });

        // Calculate overall totals by summing across all colleges
        let totalNumberOfStudents = 0;
        let totalNotRegisteredNotVoted = 0;
        let totalRegisteredNotVoted = 0;
        let totalRegisteredVoted = 0;

        electionConfig.colleges.forEach((collegeObj) => {
          totalNumberOfStudents += collegeObj.numberOfStudents;
          totalNotRegisteredNotVoted += collegeObj.notRegisteredNotVoted;
          totalRegisteredNotVoted += collegeObj.registeredNotVoted;
          totalRegisteredVoted += collegeObj.registeredVoted;
        });

        // Update the overall totals in electionConfig
        electionConfig.totalNumberOfStudents = totalNumberOfStudents;
        electionConfig.totalNotRegisteredNotVoted = totalNotRegisteredNotVoted;
        electionConfig.totalRegisteredNotVoted = totalRegisteredNotVoted;
        electionConfig.totalRegisteredVoted = totalRegisteredVoted;

        // Save updated college data and totals back to the database
        await electionConfigCollection.updateOne(
          { _id: electionConfig._id },
          {
            $set: {
              colleges: electionConfig.colleges,
              totalNumberOfStudents,
              totalNotRegisteredNotVoted,
              totalRegisteredNotVoted,
              totalRegisteredVoted,
            },
          }
        );

        // Determine the current period using fakeCurrentDate if enabled
        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        // Render the view (using the same EJS partial as /voter-turnout)
        res.render("homepages/rvs-voter-turnout", {
          electionConfig,
          loggedInAdmin: req.session && req.session.admin,
          moment,
        });
      } catch (error) {
        console.error("Error fetching voter turnout:", error);
        res.status(500).send("Server error while fetching voter turnout");
      }
    });

    app.get("/get-candidates-results", async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});

        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        // Call the getCandidateDetails function from the contract
        const [candidateIds, voteCounts] = await contract.getCandidateDetails();

        // Fetch candidates from MongoDB
        const aggregatedData = await db.collection("aggregatedCandidates").findOne({});
        const allCandidates = aggregatedData.candidates;

        // Combine Blockchain Data with Candidate Info
        const candidates = candidateIds.map((id, index) => {
          const candidate = allCandidates.find((c) => c.uniqueId === id.toString());

          return {
            candidateId: id.toString(),
            name: candidate ? candidate.name : "Unknown Candidate",
            party: candidate ? candidate.party : "Unknown Party",
            position: candidate ? candidate.position : "Unknown Position",
            image: candidate ? candidate.image : "No Image",
            college: candidate ? candidate.college : "",
            program: candidate ? candidate.program : "",
            voteCount: voteCounts[index].toString(),
          };
        });

        // Respond with JSON data
        res.json({ candidates, electionConfig });
      } catch (error) {
        console.error("Error fetching candidate details:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.get("/api/voter-ids/:uniqueId", async (req, res) => {
      try {
        const db = await connectToDatabase();
        const candidateHashesCollection = db.collection("candidate_hashes");

        const candidate = await candidateHashesCollection.findOne({ candidateId: req.params.uniqueId });

        if (!candidate) {
          return res.status(404).json({ error: "Candidate not found" });
        }

        res.json({ emails: candidate.emails || [] }); // Return the emails (or voter IDs)
      } catch (error) {
        console.error("Error fetching voter IDs:", error);
        res.status(500).json({ error: "Failed to fetch voter IDs" });
      }
    });

    // New API endpoint to list all candidate details (IDs and vote counts) from the blockchain
    app.get("/vote-tally", ensureAdminAuthenticated, async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});

        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);
        // Call the getCandidateDetails function from the contract
        const [candidateIds, voteCounts] = await contract.getCandidateDetails();

        // Fetch candidates from MongoDB
        const aggregatedData = await db.collection("aggregatedCandidates").findOne({});
        const allCandidates = aggregatedData.candidates;

        // Combine Blockchain Data with Candidate Info
        const candidates = candidateIds.map((id, index) => {
          const candidate = allCandidates.find((c) => c.uniqueId === id.toString());

          return {
            candidateId: id.toString(),
            name: candidate ? candidate.name : "Unknown Candidate",
            party: candidate ? candidate.party : "Unknown Party",
            position: candidate ? candidate.position : "Unknown Position",
            image: candidate ? candidate.image : "No Image",
            college: candidate ? candidate.college : "",
            program: candidate ? candidate.program : "",
            voteCount: voteCounts[index].toString(),
            uniqueId: candidate ? candidate.uniqueId : "",
          };
        });

        res.render("admin/election-vote-tally", { candidates, electionConfig, loggedInAdmin: req.session.admin, moment });
      } catch (error) {
        console.error("Error fetching candidate details:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.get("/vote-tally/save", ensureAdminAuthenticated, async (req, res) => {
      try {
        // Fetch election configuration and compute the current period
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});
        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        // Retrieve candidate details from the blockchain
        const [candidateIds, voteCounts] = await contract.getCandidateDetails();

        // Fetch candidate info from MongoDB
        const aggregatedData = await db.collection("aggregatedCandidates").findOne({});
        const allCandidates = aggregatedData.candidates;

        // Combine blockchain data with candidate info
        let candidates = candidateIds.map((id, index) => {
          const candidate = allCandidates.find((c) => c.uniqueId === id.toString());
          return {
            candidateId: id.toString(),
            name: candidate ? candidate.name : "Unknown Candidate",
            party: candidate ? candidate.party : "Unknown Party",
            position: candidate ? candidate.position : "Unknown Position",
            image: candidate ? candidate.image : "No Image",
            college: candidate ? candidate.college : "",
            program: candidate ? candidate.program : "",
            voteCount: voteCounts[index].toString(),
            uniqueId: candidate ? candidate.uniqueId : "",
          };
        });

        // For each candidate, fetch the vote hashes from the candidate_hashes collection.
        // This uses the same approach as your /api/voter-ids/:uniqueId endpoint.
        const candidateHashesCollection = db.collection("candidate_hashes");
        candidates = await Promise.all(
          candidates.map(async (candidate) => {
            const candidateHashes = await candidateHashesCollection.findOne({
              candidateId: candidate.uniqueId,
            });
            return {
              ...candidate,
              hashes: candidateHashes ? candidateHashes.emails : [],
            };
          })
        );

        // Prepare the document for storage
        const voteTallyData = {
          timestamp: new Date(),
          electionConfig, // includes the current period and other election settings
          candidates, // includes candidate info along with vote counts and hashes
        };

        // Insert the document into the vote_tally collection
        const voteTallyCollection = db.collection("vote_tally");
        // await voteTallyCollection.insertOne(voteTallyData);
        await voteTallyCollection.replaceOne({}, voteTallyData, { upsert: true });

        res.send("Vote tally data (including hashes) saved successfully.");
      } catch (error) {
        console.error("Error saving vote tally data:", error);
        res.status(500).send("Server error while saving vote tally data");
      }
    });

    app.get("/rvs-votes-per-candidate", async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});

        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        // Get candidate details from the contract
        const [candidateIds, voteCounts] = await contract.getCandidateDetails();

        // Fetch candidates from MongoDB
        const aggregatedData = await db.collection("aggregatedCandidates").findOne({});
        const allCandidates = aggregatedData.candidates;

        // Combine Blockchain Data with Candidate Info
        const candidates = candidateIds.map((id, index) => {
          const candidate = allCandidates.find((c) => c.uniqueId === id.toString());
          return {
            candidateId: id.toString(),
            name: candidate ? candidate.name : "Unknown Candidate",
            party: candidate ? candidate.party : "Unknown Party",
            position: candidate ? candidate.position : "Unknown Position",
            image: candidate ? candidate.image : "No Image",
            college: candidate ? candidate.college : "",
            program: candidate ? candidate.program : "",
            voteCount: voteCounts[index].toString(),
            uniqueId: candidate ? candidate.uniqueId : "",
          };
        });

        // Render your ejs2 view and pass all the data from ejs1
        res.render("homepages/rvs-votes-per-candidate", { candidates, electionConfig });
      } catch (error) {
        console.error("Error fetching candidate details:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.get("/results", ensureAdminAuthenticated, async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});

        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);
        // Call the getCandidateDetails function from the contract
        const [candidateIds, voteCounts] = await contract.getCandidateDetails();

        // Fetch candidates from MongoDB
        const aggregatedData = await db.collection("aggregatedCandidates").findOne({});
        const allCandidates = aggregatedData.candidates;

        // Combine Blockchain Data with Candidate Info
        const candidates = candidateIds.map((id, index) => {
          const candidate = allCandidates.find((c) => c.uniqueId === id.toString());

          return {
            candidateId: id.toString(),
            name: candidate ? candidate.name : "Unknown Candidate",
            party: candidate ? candidate.party : "Unknown Party",
            position: candidate ? candidate.position : "Unknown Position",
            image: candidate ? candidate.image : "No Image",
            college: candidate ? candidate.college : "",
            program: candidate ? candidate.program : "",
            voteCount: voteCounts[index].toString(),
          };
        });

        res.render("admin/election-results", { candidates, electionConfig, loggedInAdmin: req.session.admin, moment });
      } catch (error) {
        console.error("Error fetching candidate details:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.get("/results/save", ensureAdminAuthenticated, async (req, res) => {
      try {
        // Retrieve election configuration and compute the current period
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});
        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        // Retrieve candidate details from the blockchain
        const [candidateIds, voteCounts] = await contract.getCandidateDetails();

        // Fetch candidate information from MongoDB
        const aggregatedData = await db.collection("aggregatedCandidates").findOne({});
        const allCandidates = aggregatedData.candidates;

        // Combine blockchain vote counts with candidate details
        const candidates = candidateIds.map((id, index) => {
          const candidate = allCandidates.find((c) => c.uniqueId === id.toString());
          return {
            candidateId: id.toString(),
            name: candidate ? candidate.name : "Unknown Candidate",
            party: candidate ? candidate.party : "Unknown Party",
            position: candidate ? candidate.position : "Unknown Position",
            image: candidate ? candidate.image : "No Image",
            college: candidate ? candidate.college : "",
            program: candidate ? candidate.program : "",
            voteCount: voteCounts[index].toString(),
          };
        });

        /* -------------------------------
           Process Results as in shared-results.ejs
           ------------------------------- */

        // PRESIDENT processing
        const presidentCandidates = candidates.filter((c) => c.position === "president" && c.name !== "Abstain");
        const abstainCandidate = candidates.find((c) => c.position === "president" && c.name === "Abstain");
        presidentCandidates.sort((a, b) => Number(b.voteCount) - Number(a.voteCount));
        let totalVotesPres = presidentCandidates.reduce((acc, c) => acc + (Number(c.voteCount) || 0), 0);
        const abstainVotes = abstainCandidate ? Number(abstainCandidate.voteCount) || 0 : 0;
        let maxVoteCountPres = 0;
        presidentCandidates.forEach((c) => {
          const votes = Number(c.voteCount) || 0;
          if (votes > maxVoteCountPres) maxVoteCountPres = votes;
        });
        if (abstainCandidate && abstainVotes <= maxVoteCountPres) {
          totalVotesPres += abstainVotes;
        }
        const winnersPres = presidentCandidates.filter((c) => Number(c.voteCount) === maxVoteCountPres);

        // VICE PRESIDENT processing
        const viceCandidates = candidates.filter((c) => c.position === "vice president" && c.name !== "Abstain");
        const abstainCandidateVice = candidates.find((c) => c.position === "vice president" && c.name === "Abstain");
        viceCandidates.sort((a, b) => Number(b.voteCount) - Number(a.voteCount));
        let totalVotesVice = viceCandidates.reduce((acc, c) => acc + (Number(c.voteCount) || 0), 0);
        const abstainVotesVice = abstainCandidateVice ? Number(abstainCandidateVice.voteCount) || 0 : 0;
        let maxVoteCountVice = 0;
        viceCandidates.forEach((c) => {
          const votes = Number(c.voteCount) || 0;
          if (votes > maxVoteCountVice) maxVoteCountVice = votes;
        });
        if (abstainCandidateVice && abstainVotesVice <= maxVoteCountVice) {
          totalVotesVice += abstainVotesVice;
        }
        const winnersVice = viceCandidates.filter((c) => Number(c.voteCount) === maxVoteCountVice);

        // SENATORS processing
        const senatorCandidates = candidates.filter((c) => c.position === "senator" && c.name !== "Abstain");
        senatorCandidates.sort((a, b) => Number(b.voteCount) - Number(a.voteCount));
        const totalVotesSenator = senatorCandidates.reduce((acc, c) => acc + (Number(c.voteCount) || 0), 0);
        let winnersSenator = [];
        if (senatorCandidates.length <= 7) {
          winnersSenator = senatorCandidates;
        } else {
          const threshold = Number(senatorCandidates[6].voteCount) || 0;
          winnersSenator = senatorCandidates.filter((c) => (Number(c.voteCount) || 0) >= threshold);
        }
        const calculatedTotalVotesSenator = winnersSenator.reduce((acc, c) => acc + (Number(c.voteCount) || 0), 0);

        // LOCAL STUDENT COUNCIL (LSC) - Governor & Vice Governor processing
        const colleges = ["CAFA", "CAL", "CBEA", "CCJE", "CHTM", "CICT", "CIT", "CN", "COE", "COED", "CS", "CSER", "CSSP"];

        // Governor Results (grouped by college)
        const governorCandidates = candidates.filter((c) => c.position === "governor" && c.college && c.name !== "Abstain");
        const abstainCandidateGovernor = candidates.find((c) => c.position === "governor" && c.college && c.name === "Abstain");
        const governorResults = [];
        colleges.forEach((college) => {
          let collegeCandidates = governorCandidates.filter((c) => c.college === college);
          if (collegeCandidates.length) {
            collegeCandidates.sort((a, b) => Number(b.voteCount) - Number(a.voteCount));
            let collegeTotalVotes = collegeCandidates.reduce((acc, c) => acc + (Number(c.voteCount) || 0), 0);
            let abstainVotes = 0;
            if (abstainCandidateGovernor && abstainCandidateGovernor.college === college) {
              abstainVotes = Number(abstainCandidateGovernor.voteCount) || 0;
              if (collegeCandidates[0] && abstainVotes <= Number(collegeCandidates[0].voteCount)) {
                collegeTotalVotes += abstainVotes;
              }
            }
            let maxVoteCount = 0;
            collegeCandidates.forEach((c) => {
              const votes = Number(c.voteCount) || 0;
              if (votes > maxVoteCount) maxVoteCount = votes;
            });
            const winners = collegeCandidates.filter((c) => Number(c.voteCount) === maxVoteCount);
            governorResults.push({
              college,
              winners,
              totalVotes: collegeTotalVotes,
              maxVoteCount,
            });
          }
        });

        // Vice Governor Results (grouped by college)
        const viceGovernorCandidates = candidates.filter((c) => c.position === "vice governor" && c.college && c.name !== "Abstain");
        const abstainCandidateViceGovernor = candidates.find((c) => c.position === "vice governor" && c.college && c.name === "Abstain");
        const viceGovernorResults = [];
        colleges.forEach((college) => {
          let collegeCandidates = viceGovernorCandidates.filter((c) => c.college === college);
          if (collegeCandidates.length) {
            collegeCandidates.sort((a, b) => Number(b.voteCount) - Number(a.voteCount));
            let collegeTotalVotes = collegeCandidates.reduce((acc, c) => acc + (Number(c.voteCount) || 0), 0);
            let abstainVotes = 0;
            if (abstainCandidateViceGovernor && abstainCandidateViceGovernor.college === college) {
              abstainVotes = Number(abstainCandidateViceGovernor.voteCount) || 0;
              if (collegeCandidates[0] && abstainVotes <= Number(collegeCandidates[0].voteCount)) {
                collegeTotalVotes += abstainVotes;
              }
            }
            let maxVoteCount = 0;
            collegeCandidates.forEach((c) => {
              const votes = Number(c.voteCount) || 0;
              if (votes > maxVoteCount) maxVoteCount = votes;
            });
            const winners = collegeCandidates.filter((c) => Number(c.voteCount) === maxVoteCount);
            viceGovernorResults.push({
              college,
              winners,
              totalVotes: collegeTotalVotes,
              maxVoteCount,
            });
          }
        });

        // BOARD MEMBERS (grouped by program)
        const boardMembersAll = candidates.filter((c) => c.position === "board member" && c.college && c.program);
        const boardMembersNonAbstain = boardMembersAll.filter((c) => c.name !== "Abstain");
        const boardMembersAbstain = boardMembersAll.filter((c) => c.name === "Abstain");
        let boardMembersByProgram = {};
        boardMembersNonAbstain.forEach((c) => {
          if (!boardMembersByProgram[c.program]) {
            boardMembersByProgram[c.program] = [];
          }
          boardMembersByProgram[c.program].push(c);
        });
        Object.keys(boardMembersByProgram).forEach((program) => {
          boardMembersByProgram[program].sort((a, b) => Number(b.voteCount) - Number(a.voteCount));
          const highestVoteCount = boardMembersByProgram[program][0]?.voteCount || 0;
          boardMembersByProgram[program] = boardMembersByProgram[program].filter((c) => Number(c.voteCount) === Number(highestVoteCount));
        });
        let abstainByProgram = {};
        boardMembersAbstain.forEach((c) => {
          if (!abstainByProgram[c.program]) {
            abstainByProgram[c.program] = [];
          }
          abstainByProgram[c.program].push(c);
        });

        // Assemble the results object
        const resultsData = {
          timestamp: new Date(),
          electionConfig,
          president: {
            winners: winnersPres,
            totalVotes: totalVotesPres,
            maxVoteCount: maxVoteCountPres,
          },
          vicePresident: {
            winners: winnersVice,
            totalVotes: totalVotesVice,
            maxVoteCount: maxVoteCountVice,
          },
          senators: {
            winners: winnersSenator,
            totalVotes: calculatedTotalVotesSenator,
          },
          governors: governorResults,
          viceGovernors: viceGovernorResults,
          boardMembers: {
            winnersByProgram: boardMembersByProgram,
            abstain: abstainByProgram,
          },
        };

        // Save the results data into the "results" collection
        const resultsCollection = db.collection("results");
        await resultsCollection.insertOne(resultsData);

        res.send("Election results saved successfully in the results collection.");
      } catch (error) {
        console.error("Error saving election results:", error);
        res.status(500).send("Server error while saving election results");
      }
    });

    app.get("/rvs-election-results", async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});

        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        // Call the getCandidateDetails function from the contract
        const [candidateIds, voteCounts] = await contract.getCandidateDetails();

        // Fetch candidates from MongoDB
        const aggregatedData = await db.collection("aggregatedCandidates").findOne({});
        const allCandidates = aggregatedData.candidates;

        // Combine Blockchain Data with Candidate Info
        const candidates = candidateIds.map((id, index) => {
          const candidate = allCandidates.find((c) => c.uniqueId === id.toString());
          return {
            candidateId: id.toString(),
            name: candidate ? candidate.name : "Unknown Candidate",
            party: candidate ? candidate.party : "Unknown Party",
            position: candidate ? candidate.position : "Unknown Position",
            image: candidate ? candidate.image : "No Image",
            college: candidate ? candidate.college : "",
            program: candidate ? candidate.program : "",
            voteCount: voteCounts[index].toString(),
          };
        });

        res.render("homepages/rvs-election-results", { candidates, electionConfig });
      } catch (error) {
        console.error("Error fetching candidate details:", error);
        res.status(500).json({ error: error.message });
      }
    });

    app.get("/reset", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      res.render("admin/election-reset", { electionConfig, loggedInAdmin: req.session.admin, moment });
    });

    // Function to update and save voter turnout data
    async function saveVoterTurnoutData() {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});

        const votersCollection = db.collection("registered_voters");

        // Aggregate counts for "Registered" statuses per college
        const collegeRegisteredAggregation = await votersCollection
          .aggregate([
            {
              $group: {
                _id: "$college",
                count: {
                  $sum: { $cond: [{ $eq: ["$status", "Registered"] }, 1, 0] },
                },
              },
            },
          ])
          .toArray();

        // Aggregate counts for "Voted" statuses per college
        const collegeVotedAggregation = await votersCollection
          .aggregate([
            {
              $group: {
                _id: "$college",
                count: {
                  $sum: { $cond: [{ $eq: ["$status", "Voted"] }, 1, 0] },
                },
              },
            },
          ])
          .toArray();

        // Update each college object in electionConfig.colleges with computed values and percentages
        electionConfig.colleges.forEach((collegeObj) => {
          // Extract acronym from the registered_voters college field using regex.
          const regGroup = collegeRegisteredAggregation.find((g) => {
            const match = g._id.match(/\(([^)]+)\)/);
            return match && match[1] === collegeObj.acronym;
          });
          const votedGroup = collegeVotedAggregation.find((g) => {
            const match = g._id.match(/\(([^)]+)\)/);
            return match && match[1] === collegeObj.acronym;
          });

          collegeObj.registeredNotVoted = regGroup ? regGroup.count : 0;
          collegeObj.registeredVoted = votedGroup ? votedGroup.count : 0;
          collegeObj.notRegisteredNotVoted = collegeObj.numberOfStudents - (collegeObj.registeredNotVoted + collegeObj.registeredVoted);

          // Compute the turnout percentage for the college
          collegeObj.voterTurnoutPercentage = collegeObj.numberOfStudents > 0 ? ((collegeObj.registeredVoted / collegeObj.numberOfStudents) * 100).toFixed(2) : "0.00";
        });

        // Calculate overall totals
        let totalNumberOfStudents = 0;
        let totalRegisteredVoted = 0;

        electionConfig.colleges.forEach((collegeObj) => {
          totalNumberOfStudents += collegeObj.numberOfStudents;
          totalRegisteredVoted += collegeObj.registeredVoted;
        });

        // Update overall totals and overall turnout percentage in electionConfig
        electionConfig.totalNumberOfStudents = totalNumberOfStudents;
        electionConfig.totalRegisteredVoted = totalRegisteredVoted;
        electionConfig.overallVoterTurnoutPercentage = totalNumberOfStudents > 0 ? ((totalRegisteredVoted / totalNumberOfStudents) * 100).toFixed(2) : "0.00";

        // Determine the current period using fakeCurrentDate if enabled
        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        // Prepare the document to be stored
        const voterTurnoutData = {
          timestamp: new Date(),
          data: electionConfig,
        };

        // Save the computed data into the "voter_turnout" collection
        const voterTurnoutCollection = db.collection("voter_turnout");
        // await voterTurnoutCollection.insertOne(voterTurnoutData);
        await voterTurnoutCollection.replaceOne({}, voterTurnoutData, { upsert: true });

        return "Voter turnout data saved successfully.";
      } catch (error) {
        console.error("Error saving voter turnout data:", error);
        throw error;
      }
    }

    // Function to compute and save vote tally data
    async function saveVoteTallyData() {
      try {
        // Fetch election configuration and compute the current period
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});
        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        // Retrieve candidate details from the blockchain
        const [candidateIds, voteCounts] = await contract.getCandidateDetails();

        // Fetch candidate info from MongoDB
        const aggregatedData = await db.collection("aggregatedCandidates").findOne({});
        const allCandidates = aggregatedData.candidates;

        // Combine blockchain data with candidate info
        let candidates = candidateIds.map((id, index) => {
          const candidate = allCandidates.find((c) => c.uniqueId === id.toString());
          return {
            candidateId: id.toString(),
            name: candidate ? candidate.name : "Unknown Candidate",
            party: candidate ? candidate.party : "Unknown Party",
            position: candidate ? candidate.position : "Unknown Position",
            image: candidate ? candidate.image : "No Image",
            college: candidate ? candidate.college : "",
            program: candidate ? candidate.program : "",
            voteCount: voteCounts[index].toString(),
            uniqueId: candidate ? candidate.uniqueId : "",
          };
        });

        // For each candidate, fetch the vote hashes from the candidate_hashes collection.
        const candidateHashesCollection = db.collection("candidate_hashes");
        candidates = await Promise.all(
          candidates.map(async (candidate) => {
            const candidateHashes = await candidateHashesCollection.findOne({
              candidateId: candidate.uniqueId,
            });
            return {
              ...candidate,
              hashes: candidateHashes ? candidateHashes.emails : [],
            };
          })
        );

        // Prepare the document for storage
        const voteTallyData = {
          timestamp: new Date(),
          electionConfig, // includes the current period and other election settings
          candidates, // includes candidate info along with vote counts and hashes
        };

        // Insert the document into the vote_tally collection
        const voteTallyCollection = db.collection("vote_tally");
        await voteTallyCollection.insertOne(voteTallyData);

        return "Vote tally data (including hashes) saved successfully.";
      } catch (error) {
        console.error("Error saving vote tally data:", error);
        throw error;
      }
    }

    // Function to compute and save election results data
    async function saveResultsData() {
      try {
        // Retrieve election configuration and compute the current period
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});
        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        // Retrieve candidate details from the blockchain
        const [candidateIds, voteCounts] = await contract.getCandidateDetails();

        // Fetch candidate information from MongoDB
        const aggregatedData = await db.collection("aggregatedCandidates").findOne({});
        const allCandidates = aggregatedData.candidates;

        // Combine blockchain vote counts with candidate details
        const candidates = candidateIds.map((id, index) => {
          const candidate = allCandidates.find((c) => c.uniqueId === id.toString());
          return {
            candidateId: id.toString(),
            name: candidate ? candidate.name : "Unknown Candidate",
            party: candidate ? candidate.party : "Unknown Party",
            position: candidate ? candidate.position : "Unknown Position",
            image: candidate ? candidate.image : "No Image",
            college: candidate ? candidate.college : "",
            program: candidate ? candidate.program : "",
            voteCount: voteCounts[index].toString(),
          };
        });

        /* -------------------------------
       Process Results as in shared-results.ejs
       ------------------------------- */

        // PRESIDENT processing
        const presidentCandidates = candidates.filter((c) => c.position === "president" && c.name !== "Abstain");
        const abstainCandidate = candidates.find((c) => c.position === "president" && c.name === "Abstain");
        presidentCandidates.sort((a, b) => Number(b.voteCount) - Number(a.voteCount));
        let totalVotesPres = presidentCandidates.reduce((acc, c) => acc + (Number(c.voteCount) || 0), 0);
        const abstainVotes = abstainCandidate ? Number(abstainCandidate.voteCount) || 0 : 0;
        let maxVoteCountPres = 0;
        presidentCandidates.forEach((c) => {
          const votes = Number(c.voteCount) || 0;
          if (votes > maxVoteCountPres) maxVoteCountPres = votes;
        });
        if (abstainCandidate && abstainVotes <= maxVoteCountPres) {
          totalVotesPres += abstainVotes;
        }
        const winnersPres = presidentCandidates.filter((c) => Number(c.voteCount) === maxVoteCountPres);

        // VICE PRESIDENT processing
        const viceCandidates = candidates.filter((c) => c.position === "vice president" && c.name !== "Abstain");
        const abstainCandidateVice = candidates.find((c) => c.position === "vice president" && c.name === "Abstain");
        viceCandidates.sort((a, b) => Number(b.voteCount) - Number(a.voteCount));
        let totalVotesVice = viceCandidates.reduce((acc, c) => acc + (Number(c.voteCount) || 0), 0);
        const abstainVotesVice = abstainCandidateVice ? Number(abstainCandidateVice.voteCount) || 0 : 0;
        let maxVoteCountVice = 0;
        viceCandidates.forEach((c) => {
          const votes = Number(c.voteCount) || 0;
          if (votes > maxVoteCountVice) maxVoteCountVice = votes;
        });
        if (abstainCandidateVice && abstainVotesVice <= maxVoteCountVice) {
          totalVotesVice += abstainVotesVice;
        }
        const winnersVice = viceCandidates.filter((c) => Number(c.voteCount) === maxVoteCountVice);

        // SENATORS processing
        const senatorCandidates = candidates.filter((c) => c.position === "senator" && c.name !== "Abstain");
        senatorCandidates.sort((a, b) => Number(b.voteCount) - Number(a.voteCount));
        const totalVotesSenator = senatorCandidates.reduce((acc, c) => acc + (Number(c.voteCount) || 0), 0);
        let winnersSenator = [];
        if (senatorCandidates.length <= 7) {
          winnersSenator = senatorCandidates;
        } else {
          const threshold = Number(senatorCandidates[6].voteCount) || 0;
          winnersSenator = senatorCandidates.filter((c) => (Number(c.voteCount) || 0) >= threshold);
        }
        const calculatedTotalVotesSenator = winnersSenator.reduce((acc, c) => acc + (Number(c.voteCount) || 0), 0);

        // LOCAL STUDENT COUNCIL (LSC) - Governor & Vice Governor processing
        const colleges = ["CAFA", "CAL", "CBEA", "CCJE", "CHTM", "CICT", "CIT", "CN", "COE", "COED", "CS", "CSER", "CSSP"];

        // Governor Results (grouped by college)
        const governorCandidates = candidates.filter((c) => c.position === "governor" && c.college && c.name !== "Abstain");
        const abstainCandidateGovernor = candidates.find((c) => c.position === "governor" && c.college && c.name === "Abstain");
        const governorResults = [];
        colleges.forEach((college) => {
          let collegeCandidates = governorCandidates.filter((c) => c.college === college);
          if (collegeCandidates.length) {
            collegeCandidates.sort((a, b) => Number(b.voteCount) - Number(a.voteCount));
            let collegeTotalVotes = collegeCandidates.reduce((acc, c) => acc + (Number(c.voteCount) || 0), 0);
            let abstainVotes = 0;
            if (abstainCandidateGovernor && abstainCandidateGovernor.college === college) {
              abstainVotes = Number(abstainCandidateGovernor.voteCount) || 0;
              if (collegeCandidates[0] && abstainVotes <= Number(collegeCandidates[0].voteCount)) {
                collegeTotalVotes += abstainVotes;
              }
            }
            let maxVoteCount = 0;
            collegeCandidates.forEach((c) => {
              const votes = Number(c.voteCount) || 0;
              if (votes > maxVoteCount) maxVoteCount = votes;
            });
            const winners = collegeCandidates.filter((c) => Number(c.voteCount) === maxVoteCount);
            governorResults.push({
              college,
              winners,
              totalVotes: collegeTotalVotes,
              maxVoteCount,
            });
          }
        });

        // Vice Governor Results (grouped by college)
        const viceGovernorCandidates = candidates.filter((c) => c.position === "vice governor" && c.college && c.name !== "Abstain");
        const abstainCandidateViceGovernor = candidates.find((c) => c.position === "vice governor" && c.college && c.name === "Abstain");
        const viceGovernorResults = [];
        colleges.forEach((college) => {
          let collegeCandidates = viceGovernorCandidates.filter((c) => c.college === college);
          if (collegeCandidates.length) {
            collegeCandidates.sort((a, b) => Number(b.voteCount) - Number(a.voteCount));
            let collegeTotalVotes = collegeCandidates.reduce((acc, c) => acc + (Number(c.voteCount) || 0), 0);
            let abstainVotes = 0;
            if (abstainCandidateViceGovernor && abstainCandidateViceGovernor.college === college) {
              abstainVotes = Number(abstainCandidateViceGovernor.voteCount) || 0;
              if (collegeCandidates[0] && abstainVotes <= Number(collegeCandidates[0].voteCount)) {
                collegeTotalVotes += abstainVotes;
              }
            }
            let maxVoteCount = 0;
            collegeCandidates.forEach((c) => {
              const votes = Number(c.voteCount) || 0;
              if (votes > maxVoteCount) maxVoteCount = votes;
            });
            const winners = collegeCandidates.filter((c) => Number(c.voteCount) === maxVoteCount);
            viceGovernorResults.push({
              college,
              winners,
              totalVotes: collegeTotalVotes,
              maxVoteCount,
            });
          }
        });

        // BOARD MEMBERS (grouped by program)
        const boardMembersAll = candidates.filter((c) => c.position === "board member" && c.college && c.program);
        const boardMembersNonAbstain = boardMembersAll.filter((c) => c.name !== "Abstain");
        const boardMembersAbstain = boardMembersAll.filter((c) => c.name === "Abstain");
        let boardMembersByProgram = {};
        boardMembersNonAbstain.forEach((c) => {
          if (!boardMembersByProgram[c.program]) {
            boardMembersByProgram[c.program] = [];
          }
          boardMembersByProgram[c.program].push(c);
        });
        Object.keys(boardMembersByProgram).forEach((program) => {
          boardMembersByProgram[program].sort((a, b) => Number(b.voteCount) - Number(a.voteCount));
          const highestVoteCount = boardMembersByProgram[program][0]?.voteCount || 0;
          boardMembersByProgram[program] = boardMembersByProgram[program].filter((c) => Number(c.voteCount) === Number(highestVoteCount));
        });
        let abstainByProgram = {};
        boardMembersAbstain.forEach((c) => {
          if (!abstainByProgram[c.program]) {
            abstainByProgram[c.program] = [];
          }
          abstainByProgram[c.program].push(c);
        });

        // Assemble the results object
        const resultsData = {
          timestamp: new Date(),
          electionConfig,
          president: {
            winners: winnersPres,
            totalVotes: totalVotesPres,
            maxVoteCount: maxVoteCountPres,
          },
          vicePresident: {
            winners: winnersVice,
            totalVotes: totalVotesVice,
            maxVoteCount: maxVoteCountVice,
          },
          senators: {
            winners: winnersSenator,
            totalVotes: calculatedTotalVotesSenator,
          },
          governors: governorResults,
          viceGovernors: viceGovernorResults,
          boardMembers: {
            winnersByProgram: boardMembersByProgram,
            abstain: abstainByProgram,
          },
        };

        // Save the results data into the "results" collection
        const resultsCollection = db.collection("results");
        // await resultsCollection.insertOne(resultsData);
        await resultsCollection.replaceOne({}, resultsData, { upsert: true });

        return "Election results saved successfully in the results collection.";
      } catch (error) {
        console.error("Error saving election results:", error);
        throw error;
      }
    }

    // Reset-election route that calls the three functions and archives the data
    app.post("/reset-election", ensureAdminAuthenticated, async (req, res) => {
      try {
        // 1. Get the current election configuration document
        const electionConfig = await db.collection("election_config").findOne({});
        if (!electionConfig) {
          return res.status(404).send("Election configuration not found.");
        }

        // Use the specialStatus if it's "Results Are Out"
        const electionName = electionConfig.electionName || "Unnamed Election";
        let electionStatus = electionConfig.electionStatus;
        if (electionConfig.specialStatus === "Results Are Out") {
          electionStatus = electionConfig.specialStatus;
        }

        // 2. Prepare registration and voting period objects
        const registrationPeriod = {
          start: electionConfig.registrationStart,
          end: electionConfig.registrationEnd,
        };
        const votingPeriod = {
          start: electionConfig.votingStart,
          end: electionConfig.votingEnd,
        };

        // BEFORE #3: Update and store additional election data by calling helper functions.
        await saveVoterTurnoutData();
        await saveVoteTallyData();
        await saveResultsData();

        // 3. Read whole collections from the database, including computed data
        const configDocs = await db.collection("election_config").find({}).toArray();
        const candidatesDocs = await db.collection("candidates").find({}).toArray();
        const candidatesLSCDocs = await db.collection("candidates_lsc").find({}).toArray();
        const registeredVotersDocs = await db.collection("registered_voters").find({}).toArray();
        const voterTurnoutDocs = await db.collection("voter_turnout").find({}).toArray();
        const voteTallyDocs = await db.collection("vote_tally").find({}).toArray();
        const resultsDocs = await db.collection("results").find({}).toArray();

        // 4. Prepare the archive document, including all computed data
        const archiveDoc = {
          archivedAt: new Date(),
          electionName,
          electionStatus,
          registrationPeriod,
          votingPeriod,
          electionConfig: configDocs,
          candidates: candidatesDocs,
          candidates_lsc: candidatesLSCDocs,
          registeredVoters: registeredVotersDocs,
          voterTurnout: voterTurnoutDocs,
          voterTally: voteTallyDocs,
          voterResults: resultsDocs,
        };

        // 5. Insert the archive document into the election_archive collection
        await db.collection("election_archive").insertOne(archiveDoc);

        await db.collection("electionConfig").updateOne({}, { $set: { candidatesSubmitted: false } }, { upsert: true });

        const defaultElectionConfig = {
          electionStatus: "ELECTION INACTIVE",
          specialStatus: "None",
          electionName: "",
          registrationStart: { $date: "" },
          registrationEnd: { $date: "" },
          votingStart: { $date: "" },
          votingEnd: { $date: "" },
          partylists: ["Independent"],
          colleges: [
            {
              acronym: "CAFA",
              name: "College of Architecture and Fine Arts",
              numberOfStudents: 0,
              notRegisteredNotVoted: 0,
              registeredNotVoted: 0,
              registeredVoted: 0,
            },
            {
              acronym: "CAL",
              name: "College of Arts and Letters",
              numberOfStudents: 0,
              notRegisteredNotVoted: 0,
              registeredNotVoted: 0,
              registeredVoted: 0,
            },
            {
              acronym: "CBEA",
              name: "College of Business Education and Accountancy",
              numberOfStudents: 0,
              notRegisteredNotVoted: 0,
              registeredNotVoted: 0,
              registeredVoted: 0,
            },
            {
              acronym: "CCJE",
              name: "College of Criminal Justice Education",
              numberOfStudents: 0,
              notRegisteredNotVoted: 0,
              registeredNotVoted: 0,
              registeredVoted: 0,
            },
            {
              acronym: "COE",
              name: "College of Engineering",
              numberOfStudents: 0,
              notRegisteredNotVoted: 0,
              registeredNotVoted: 0,
              registeredVoted: 0,
            },
            {
              acronym: "COED",
              name: "College of Education",
              numberOfStudents: 0,
              notRegisteredNotVoted: 0,
              registeredNotVoted: 0,
              registeredVoted: 0,
            },
            {
              acronym: "CHTM",
              name: "College of Hospitality and Tourism Management",
              numberOfStudents: 0,
              notRegisteredNotVoted: 0,
              registeredNotVoted: 0,
              registeredVoted: 0,
            },
            {
              acronym: "CIT",
              name: "College of Industrial Technology",
              numberOfStudents: 0,
              notRegisteredNotVoted: 0,
              registeredNotVoted: 0,
              registeredVoted: 0,
            },
            {
              acronym: "CICT",
              name: "College of Information and Communications Technology",
              numberOfStudents: 0,
              notRegisteredNotVoted: 0,
              registeredNotVoted: 0,
              registeredVoted: 0,
            },
            {
              acronym: "CON",
              name: "College of Nursing",
              numberOfStudents: 0,
              notRegisteredNotVoted: 0,
              registeredNotVoted: 0,
              registeredVoted: 0,
            },
            {
              acronym: "CS",
              name: "College of Science",
              numberOfStudents: 0,
              notRegisteredNotVoted: 0,
              registeredNotVoted: 0,
              registeredVoted: 0,
            },
            {
              acronym: "CSSP",
              name: "College of Social Sciences and Philosophy",
              numberOfStudents: 0,
              notRegisteredNotVoted: 0,
              registeredNotVoted: 0,
              registeredVoted: 0,
            },
            {
              acronym: "CSER",
              name: "College of Sports, Exercise, and Recreation",
              numberOfStudents: 0,
              notRegisteredNotVoted: 0,
              registeredNotVoted: 0,
              registeredVoted: 0,
            },
          ],
          fakeCurrentDate: new Date(),
          updatedAt: { $date: "" },
          createdAt: { $date: "" },
          useFakeDate: false,
          candidatesSubmitted: false,
          totalNotRegisteredNotVoted: 0,
          totalNumberOfStudents: 0,
          totalRegisteredNotVoted: 0,
          totalRegisteredVoted: 0,
          totalCandidates: 0,
        };
        // NEW FEATURE: Reset election_config to default values.
        await db.collection("election_config").updateOne({}, { $set: defaultElectionConfig });

        // 6. (Optional) Delete the current election data.
        await db.collection("registered_voters").deleteMany({});
        await contract.resetCandidates();

        // Log the archiving activity (assuming logActivity is defined)
        await logActivity("system_activity_logs", "Reset Election Archiving", "Admin", req, "Archived election data.");

        res.redirect("/reset?reset=success");
      } catch (error) {
        console.error("Error in reset-election route:", error);
        res.status(500).send("Error resetting election.");
      }
    });

    app.get("/api/resetCandidates", async (req, res) => {
      try {
        // Authorization check
        if (!req.session.admin || req.session.admin.role !== "Developer") {
          return res.status(403).send("Unauthorized");
        }

        // Reset candidates on blockchain
        const resetTx = await contract.resetCandidates();
        const resetReceipt = await resetTx.wait();

        // Update the electionConfig's candidatesSubmitted field to false
        await db.collection("election_config").updateOne({}, { $set: { candidatesSubmitted: false } });

        // Fetch crypto prices for cost calculation
        const priceData = await getCryptoPrices();
        if (!priceData) console.log("Failed to fetch crypto prices. Skipping cost calculation.");

        // Log blockchain activity for candidate reset
        await recordBlockchainActivity("blockchain_activity_logs", "Candidates Reset", "Admin", req, [resetReceipt], priceData);

        // Aggregate gas costs
        const totalGasUsed = Number(resetReceipt.gasUsed);
        const totalGasPrice = Number(resetReceipt.gasPrice);
        const resetCostWei = totalGasUsed * totalGasPrice;
        const resetCostInPOL = resetCostWei / 1e18;

        let { ethPricePhp = 0, ethPriceUsd = 0, polPricePhp = 0, polPriceUsd = 0 } = priceData || {};
        if (!polPricePhp && polPriceUsd && ethPricePhp && ethPriceUsd) {
          polPricePhp = (polPriceUsd / ethPriceUsd) * ethPricePhp;
        }
        const resetCostPHP = polPricePhp ? resetCostInPOL * polPricePhp : "N/A";
        const resetCostUSD = polPriceUsd ? resetCostInPOL * polPriceUsd : "N/A";

        // Update blockchain_management collection
        await db.collection("blockchain_management").updateOne(
          {},
          {
            $set: {
              lastResetTransactionHash: resetReceipt.hash,
              lastResetDate: new Date(),
              lastResetCostGas: totalGasUsed,
              lastResetCostWei: resetCostWei,
              lastResetCostPHP: resetCostPHP,
              lastResetCostUSD: resetCostUSD,
              lastResetCostInPOL: resetCostInPOL,
            },
            $inc: {
              candidateResetsCount: 1,
              totalGasUsedInResets: totalGasUsed,
              totalWeiSpentInResets: resetCostWei,
              totalAmountSpentInResetsPol: resetCostInPOL,
              totalAmountSpentInResetsUSD: resetCostUSD === "N/A" ? 0 : resetCostUSD,
              totalAmountSpentInResetsPHP: resetCostPHP === "N/A" ? 0 : resetCostPHP,
            },
          },
          { upsert: true }
        );

        res.status(200).json({
          message: "Candidates reset successfully",
          blockchainTxReceipt: resetReceipt,
          resetTransactionHash: resetReceipt.hash,
          resetCostInPOL,
          resetCostPHP,
          resetCostUSD,
        });
      } catch (error) {
        console.error("Error resetting candidates:", error);
        res.status(500).send("Error resetting candidates");
      }
    });

    app.post("/api/update-voting-period", async (req, res) => {
      try {
        // Optionally, add your authorization check here:
        if (!req.session.admin || req.session.admin.role !== "Developer") {
          return res.status(403).send({ success: false, error: "Unauthorized" });
        }

        // Fetch current election config
        const electionConfig = await db.collection("election_config").findOne({});
        if (!electionConfig || !electionConfig.votingStart || !electionConfig.votingEnd) {
          return res.status(400).send({ success: false, error: "Voting period not found in config" });
        }

        // Parse dates and add 1 day
        let voteStartTime = moment.tz(electionConfig.votingStart, "Asia/Manila").add(1, "days");
        let voteEndTime = moment.tz(electionConfig.votingEnd, "Asia/Manila").add(1, "days");

        // Update database
        await db.collection("election_config").updateOne(
          {},
          {
            $set: {
              votingStart: voteStartTime.toISOString(),
              votingEnd: voteEndTime.toISOString(),
            },
          }
        );

        res.status(200).send({ success: true });
      } catch (error) {
        console.error("Error updating voting period:", error);
        res.status(500).send({ success: false, error: "Error updating voting period" });
      }
    });

    // Route for rendering archives
    app.get("/archives", async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});
        const archives = await db.collection("election_archive").find({}).toArray();

        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);
        res.render("admin/archives", { archives, electionConfig, loggedInAdmin: req.session.admin, moment });
      } catch (error) {
        console.error("Error fetching archives:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    // Route for downloading all sections as a zip file in JSON or CSV format
    app.get("/api/download-archive/:id/all/:format", async (req, res) => {
      try {
        const { id, format } = req.params;
        console.log(`📥 Received request to download all sections for archive ID: ${id} in ${format.toUpperCase()} format`);

        if (!["json", "csv"].includes(format)) {
          console.log("❌ Invalid format requested:", format);
          return res.status(400).send("Invalid format requested");
        }

        const archive = await db.collection("election_archive").findOne({ _id: new ObjectId(id) });
        if (!archive) {
          console.log("❌ Archive not found for ID:", id);
          return res.status(404).send("Archive not found");
        }

        // Log all keys available in the archive document
        console.log("✅ Archive found! Available sections:", Object.keys(archive));

        // List of expected sections
        const sections = ["electionConfig", "candidates", "candidates_lsc", "registeredVoters", "voterTurnout", "voterTally", "voterResults"];

        // Filter out missing sections (in your file, only "electionConfig" and "candidates" exist)
        const existingSections = sections.filter((section) => archive.hasOwnProperty(section));
        console.log("📂 Sections to be included in ZIP:", existingSections);

        if (existingSections.length === 0) {
          console.log("❌ No valid sections found for this archive.");
          return res.status(400).send("No valid sections found for this archive.");
        }

        // Set up headers for ZIP file
        res.setHeader("Content-Disposition", `attachment; filename=archive_${id}_all_${format}.zip`);
        res.setHeader("Content-Type", "application/zip");

        const zipArchive = archiver("zip");
        zipArchive.pipe(res);

        // Track number of files added
        let filesAdded = 0;

        for (const section of existingSections) {
          let content;
          let fileName = `${section}.${format}`;
          try {
            if (format === "json") {
              content = JSON.stringify(archive[section], null, 2);
            } else {
              let data = archive[section];
              let dataArray = Array.isArray(data) ? data : [data];
              const json2csvParser = new Parser();
              content = json2csvParser.parse(dataArray);
              console.log(`✅ Successfully converted ${section} to CSV`);
            }
            zipArchive.append(content, { name: fileName });
            console.log(`📎 Added ${fileName} to ZIP`);
            filesAdded++;
          } catch (error) {
            console.error(`❌ Error processing ${section}:`, error);
          }
        }

        if (filesAdded === 0) {
          console.log("❌ No files were added to the ZIP. Ending request.");
          return res.status(500).send("Failed to generate ZIP file.");
        }

        zipArchive.finalize();
        console.log("📦 ZIP file finalized and sent to client.");
      } catch (error) {
        console.error("❌ Error exporting archive all sections:", error);
        return res.status(500).send("Internal Server Error");
      }
    });

    // Route for downloading a specific section as JSON or CSV
    app.get("/api/download-archive/:id/:section/:format", async (req, res) => {
      try {
        const { id, section, format } = req.params;
        if (!["json", "csv"].includes(format)) {
          return res.status(400).send("Invalid format requested");
        }
        const archive = await db.collection("election_archive").findOne({ _id: new ObjectId(id) });
        if (!archive) return res.status(404).send("Archive not found");
        if (!archive.hasOwnProperty(section)) return res.status(400).send("Invalid section requested");

        const data = archive[section];

        if (format === "json") {
          res.setHeader("Content-Disposition", `attachment; filename=archive_${id}_${section}.json`);
          res.setHeader("Content-Type", "application/json");
          return res.send(JSON.stringify(data, null, 2));
        } else {
          let dataArray = Array.isArray(data) ? data : [data];
          try {
            const json2csvParser = new Parser();
            const csv = json2csvParser.parse(dataArray);
            res.setHeader("Content-Disposition", `attachment; filename=archive_${id}_${section}.csv`);
            res.setHeader("Content-Type", "text/csv");
            return res.send(csv);
          } catch (csvError) {
            console.error("CSV conversion error:", csvError);
            return res.status(500).send("Error converting data to CSV");
          }
        }
      } catch (error) {
        console.error("Error exporting archive section:", error);
        return res.status(500).send("Internal Server Error");
      }
    });

    app.get("/edit-account", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      res.render("admin/system-edit-account", { electionConfig, loggedInAdmin: req.session.admin, moment });
    });

    app.post("/update-account", async (req, res) => {
      console.log("=== /update-account called ===");

      // Ensure an admin is logged in
      if (!req.session.admin) {
        console.error("Session admin not found.");
        return res.status(401).json({ success: false, error: "Unauthorized access." });
      }

      console.log("Session admin:", req.session.admin);

      // Destructure form data
      const { name, email, oldPassword, newPassword, img } = req.body;
      console.log("Received data:", { name, email, oldPassword, newPassword, img });

      // Validate required fields
      if (!name || !email) {
        console.error("Missing required fields: name or email.");
        return res.json({ success: false, error: "Name and Email are required." });
      }

      // Use req.session.admin.id since that’s how it is stored
      let adminId;
      try {
        console.log("Converting session id to ObjectId. Session id:", req.session.admin.id);
        adminId = new ObjectId(req.session.admin.id);
        console.log("Converted adminId:", adminId);
      } catch (err) {
        console.error("Error converting id:", err);
        return res.json({ success: false, error: "Invalid admin id." });
      }

      // Fetch the latest admin record from the database
      try {
        console.log("Attempting to fetch admin record from database with _id:", adminId);
        const adminRecord = await db.collection("admin_accounts").findOne({ _id: adminId });
        console.log("Fetched admin record:", adminRecord);

        if (!adminRecord) {
          console.error("Admin record not found for _id:", adminId);
          return res.json({ success: false, error: "Admin record not found." });
        }

        // If a password change is attempted, validate the old password
        if (newPassword) {
          console.log("Password change attempted. Validating old password...");
          if (!oldPassword) {
            console.error("Old password not provided for password change.");
            return res.json({ success: false, error: "Old password is required to change your password." });
          }

          // For now using plain text comparison; consider using bcrypt in production
          console.log("Comparing input old password:", oldPassword, "with stored password:", adminRecord.password);
          if (oldPassword !== adminRecord.password) {
            console.error("Old password does not match.");
            return res.json({ success: false, error: "Old password is incorrect." });
          }
        }

        // Build the update object with the provided fields
        const updateObj = {
          name,
          email,
          img,
        };

        if (newPassword) {
          updateObj.password = newPassword;
        }

        console.log("Update object to be applied:", updateObj);

        // Update the document and capture the result
        const updateResult = await db.collection("admin_accounts").updateOne({ _id: adminId }, { $set: updateObj });

        console.log("Update result:", updateResult);

        if (updateResult.modifiedCount === 0) {
          console.warn("No changes were made to the account. It might be because the new data matches the existing data.");
          return res.json({ success: false, error: "No changes were made to the account." });
        }

        // Update the session with the new details. Use the same key as stored originally.
        req.session.admin = { ...req.session.admin, ...updateObj };
        console.log("Session admin updated to:", req.session.admin);

        res.json({ success: true });
      } catch (error) {
        console.error("Error during admin account update:", error);
        res.json({ success: false, error: "An error occurred while updating the account." });
      }
    });

    // app.post("/update-account", async (req, res) => {
    //   try {
    //     // Ensure the admin is authenticated
    //     if (!req.session.admin) {
    //       return res.json({ success: false, error: "Not authenticated" });
    //     }

    //     const { name, email, oldPassword, newPassword, img } = req.body;

    //     // Server-side basic validation (even though client-side validates)
    //     if (!name || !email) {
    //       return res.json({ success: false, error: "Missing required fields." });
    //     }

    //     let updateFields = { name, email, img };

    //     // If a password change is requested, verify the old password
    //     if (newPassword) {
    //       if (!oldPassword) {
    //         return res.json({ success: false, error: "Please enter your old password to change your password." });
    //       }
    //       // In production, use hashed passwords and a proper password verification method.
    //       if (req.session.admin.password !== oldPassword) {
    //         return res.json({ success: false, error: "Old password is incorrect." });
    //       }
    //       updateFields.password = newPassword;
    //     }

    //     // Update the admin record using the admin's _id
    //     const adminsCollection = db.collection("admins");
    //     const adminId = req.session.admin._id;
    //     await adminsCollection.updateOne({ _id: adminId }, { $set: updateFields });

    //     // Update session data with new details
    //     req.session.admin = { ...req.session.admin, ...updateFields };

    //     // Return a success response
    //     res.json({ success: true, message: "Profile saved successfully." });
    //   } catch (err) {
    //     console.error("Error updating account:", err);
    //     res.json({ success: false, error: "Server error." });
    //   }
    // });

    app.get("/help-page", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      res.render("admin/system-help-page", { electionConfig, loggedInAdmin: req.session.admin, moment });
    });
    app.get("/system-activity-log", async (req, res) => {
      try {
        const electionConfigCollection = db.collection("election_config");
        let electionConfig = await electionConfigCollection.findOne({});

        const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
        electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

        // Fetch system activity logs, sorted by most recent first.
        const activityLogs = await db.collection("system_activity_logs").find({}).sort({ timestamp: -1 }).toArray();

        res.render("admin/system-activity-log", {
          electionConfig,
          loggedInAdmin: req.session.admin,
          activityLogs,
          moment,
        });
      } catch (error) {
        console.error("Error fetching activity logs:", error);
        res.status(500).send("Internal Server Error");
      }
    });

    app.get("/please", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);
      res.render("homepages/index-vote-checking-period", { electionConfig });
    });
    // Routing
    app.get("/about", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      res.render("about", { electionConfig });
    });

    app.get("/contact", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      res.render("contact", { electionConfig });
    });

    app.post("/submit-contact", async (req, res) => {
      try {
        const { name, email, message } = req.body;

        if (!name || !email || !message) {
          return res.status(400).json({ message: "All fields are required." });
        }

        const messagesCollection = db.collection("messages");

        await messagesCollection.insertOne({
          name,
          email,
          message,
          submittedAt: new Date(),
        });

        res.status(200).json({ message: "Your message has been received!" });
      } catch (error) {
        console.error("Error saving contact form:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.get("/index-results-are-out-period", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      res.render("homepages/index-results-are-out-period", { electionConfig });
    });

    app.get("/rvs-about", async (req, res) => {
      const electionConfigCollection = db.collection("election_config");
      let electionConfig = await electionConfigCollection.findOne({});

      const now = electionConfig.fakeCurrentDate ? new Date(electionConfig.fakeCurrentDate) : new Date();
      electionConfig.currentPeriod = calculateCurrentPeriod(electionConfig, now);

      res.render("homepages/rvs-about", { electionConfig });
    });

    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to connect to the database:", error);
    process.exit(1);
  }
};

startServer();

// setInterval(() => {
//   console.log(process.memoryUsage());
// }, 60000); // logs memory usage every minute
