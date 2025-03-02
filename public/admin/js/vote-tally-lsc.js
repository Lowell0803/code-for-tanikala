async function renderLSCPositions(selectedCollege) {
  try {
    const response = await fetch("/get-vote-counts");
    const data = await response.json();

    if (!data.success) {
      throw new Error("Failed to fetch vote counts");
    }

    console.log("📡 Raw fetched LSC vote data:", data.results);

    // 🔥 College mapping for Board Member detection
    const collegeMap = {
      CAFA: ["Bachelor of Science in Architecture", "Bachelor of Fine Arts Major in Visual Communication", "Bachelor of Landscape Architecture"],
      CAL: ["Bachelor of Arts in Broadcasting", "Bachelor of Arts in Journalism", "Batsilyer ng Sining sa Malikhaing Pagsulat", "Bachelor of Performing Arts"],
      CBEA: ["Bachelor of Science in Accountancy/Accounting Information System", "Bachelor of Science in Business Administration", "Bachelor of Science in Entrepreneurship"],
    };

    const results = {};

    data.results.forEach((candidate) => {
      let position, college;

      if (candidate.position.startsWith("Board Member - ")) {
        // 🔥 Detect Board Members using program names
        const programName = candidate.position.replace("Board Member - ", "").trim();

        for (const [col, programs] of Object.entries(collegeMap)) {
          if (programs.includes(programName)) {
            position = `Board Member - ${programName}`;
            college = col;
            break;
          }
        }
      } else {
        // 🔥 Detect Governor / Vice Governor positions
        const match = candidate.position.match(/(.*) - (.*)/);
        if (match) {
          position = match[1].trim();
          college = match[2].trim();
        }
      }

      if (!college || !position) return; // Ignore SSC positions

      console.log(`🟢 Detected position: ${position} | College: ${college}`);

      if (!results[college]) {
        results[college] = {};
      }

      if (!results[college][position]) {
        results[college][position] = { candidates: [], abstain: 0 };
      }

      if (candidate.candidate.trim().toLowerCase() === "abstain") {
        results[college][position].abstain += parseInt(candidate.votes, 10);
      } else {
        results[college][position].candidates.push({
          name: candidate.candidate,
          votes: parseInt(candidate.votes, 10),
        });
      }
    });

    console.log("🔍 Filtered LSC results:", results);

    renderResultsLSC(results[selectedCollege] || {}, selectedCollege);
  } catch (error) {
    console.error("❌ Error fetching LSC vote counts:", error);
  }
}

function renderResultsLSC(results, college) {
  const container = document.getElementById("lsc-container");
  container.innerHTML = `<h2>${college} Local Student Council</h2>`;

  Object.keys(results).forEach((position) => {
    const positionDiv = document.createElement("div");
    positionDiv.classList.add("position-container");
    positionDiv.innerHTML = `<h3>${position}</h3>`;

    // 🔥 Calculate Total Votes for this Position
    const totalVotes = results[position].candidates.reduce((sum, c) => sum + c.votes, 0) + results[position].abstain;
    console.log(`📊 Total votes for ${position} (${college}):`, totalVotes);

    results[position].candidates.forEach((candidate) => {
      console.log(`👤 Rendering candidate: ${candidate.name} with votes: ${candidate.votes} under ${position} (${college})`);

      const candidateDiv = document.createElement("div");
      candidateDiv.classList.add("progress-element");

      const nameElement = document.createElement("p");
      nameElement.classList.add("progress-label");
      nameElement.textContent = `${candidate.name}`;

      const progressBar = document.createElement("progress");
      progressBar.max = totalVotes; // 🔥 Set total votes as max
      progressBar.value = candidate.votes; // 🔥 Candidate's votes

      const voteCount = document.createElement("span");
      voteCount.textContent = `${candidate.votes} votes`;

      candidateDiv.appendChild(nameElement);
      candidateDiv.appendChild(progressBar);
      candidateDiv.appendChild(voteCount);
      positionDiv.appendChild(candidateDiv);
    });

    console.log(`🚨 Rendering Abstain votes: ${results[position].abstain} for ${position} (${college})`);

    const abstainDiv = document.createElement("div");
    abstainDiv.classList.add("progress-element");

    const abstainLabel = document.createElement("p");
    abstainLabel.classList.add("progress-label");
    abstainLabel.textContent = "Abstain";

    const abstainProgressBar = document.createElement("progress");
    abstainProgressBar.max = totalVotes; // 🔥 Set max to total votes
    abstainProgressBar.value = results[position].abstain; // 🔥 Abstain votes

    const abstainCount = document.createElement("span");
    abstainCount.textContent = `${results[position].abstain} votes`;

    abstainDiv.appendChild(abstainLabel);
    abstainDiv.appendChild(abstainProgressBar);
    abstainDiv.appendChild(abstainCount);
    positionDiv.appendChild(abstainDiv);

    container.appendChild(positionDiv);
  });
}

// 🔥 Ensure dropdown changes the displayed results
document.getElementById("college-selector").addEventListener("change", function () {
  const selectedCollege = this.value.toUpperCase();
  console.log(`🔄 Changing to: ${selectedCollege}`);
  renderLSCPositions(selectedCollege);
});

// Initial fetch for default college
renderLSCPositions("CAFA");
