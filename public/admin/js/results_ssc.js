async function renderSSCPositions() {
  try {
    const response = await fetch("/developer/vote-counts");
    const data = await response.json();

    if (!data.success) {
      throw new Error("Failed to fetch vote counts");
    }

    console.log("📡 Raw fetched vote data:", data.results);

    const positions = ["President", "Vice President", "Senator"];
    const results = {};

    // Organize SSC data (including Abstain votes)
    data.results.forEach((candidate) => {
      const position = candidate.position;
      const votes = parseInt(candidate.votes, 10); // Ensure votes are numbers

      if (positions.includes(position)) {
        if (!results[position]) {
          results[position] = { candidates: [], abstain: 0 };
        }

        if (candidate.candidate.trim().toLowerCase() === "abstain") {
          results[position].abstain += votes; // Store Abstain votes
          console.log(`✅ Abstain votes for ${position}: ${results[position].abstain}`);
        } else {
          results[position].candidates.push({
            name: candidate.candidate,
            votes: votes,
          });
        }
      }
    });

    console.log("🔍 Filtered SSC results:", results);

    renderResultsSSC(results);
  } catch (error) {
    console.error("❌ Error fetching SSC vote counts:", error);
  }
}

// function renderResultsSSC(results) {
//   Object.keys(results).forEach((position) => {
//     const containerId = `container-${position.toLowerCase().replace(/\s+/g, "-")}`;
//     const container = document.getElementById(containerId);

//     console.log(`🖥️ Rendering position: ${position}, container ID: ${containerId}, container found:`, container !== null);

//     if (container) {
//       container.innerHTML = `<h2>${position}</h2>`;

//       results[position].candidates.forEach((candidate) => {
//         console.log(`👤 Rendering candidate: ${candidate.name} with votes: ${candidate.votes} under ${position}`);

//         const candidateDiv = document.createElement("div");
//         candidateDiv.classList.add("progress-element");

//         const nameElement = document.createElement("p");
//         nameElement.classList.add("progress-label");
//         nameElement.textContent = `${candidate.name}`;

//         const progressBar = document.createElement("progress");
//         progressBar.max = 100;
//         progressBar.value = candidate.votes;

//         const voteCount = document.createElement("span");
//         voteCount.textContent = `${candidate.votes} votes`;

//         candidateDiv.appendChild(nameElement);
//         candidateDiv.appendChild(progressBar);
//         candidateDiv.appendChild(voteCount);
//         container.appendChild(candidateDiv);
//       });

//       // 🔥 🔥 🔥 Always render Abstain votes, even if 0 🔥 🔥 🔥
//       console.log(`🚨 Rendering Abstain votes: ${results[position].abstain} for ${position}`);

//       const abstainDiv = document.createElement("div");
//       abstainDiv.classList.add("progress-element");

//       const abstainLabel = document.createElement("p");
//       abstainLabel.classList.add("progress-label");
//       abstainLabel.textContent = "Abstain";

//       const abstainProgressBar = document.createElement("progress");
//       abstainProgressBar.max = 100;
//       abstainProgressBar.value = results[position].abstain;

//       const abstainCount = document.createElement("span");
//       abstainCount.textContent = `${results[position].abstain} votes`;

//       abstainDiv.appendChild(abstainLabel);
//       abstainDiv.appendChild(abstainProgressBar);
//       abstainDiv.appendChild(abstainCount);
//       container.appendChild(abstainDiv);
//     } else {
//       console.warn(`⚠️ Container not found for position: ${position}. Check if the corresponding <div> exists in the HTML.`);
//     }
//   });
// }

// Fetch SSC results on page load

function renderResultsSSC(results) {
  Object.keys(results).forEach((position) => {
    const containerId = `container-${position.toLowerCase().replace(/\s+/g, "-")}`;
    const container = document.getElementById(containerId);

    console.log(`🖥️ Rendering position: ${position}, container ID: ${containerId}, container found:`, container !== null);

    if (container) {
      container.innerHTML = `<h2>${position}</h2>`;

      // 🔥 Calculate total votes for this position
      const totalVotes = results[position].candidates.reduce((sum, c) => sum + c.votes, 0) + results[position].abstain;
      console.log(`📊 Total votes for ${position}:`, totalVotes);

      results[position].candidates.forEach((candidate) => {
        console.log(`👤 Rendering candidate: ${candidate.name} with votes: ${candidate.votes} under ${position}`);

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
        container.appendChild(candidateDiv);
      });

      console.log(`🚨 Rendering Abstain votes: ${results[position].abstain} for ${position}`);

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
      container.appendChild(abstainDiv);
    } else {
      console.warn(`⚠️ Container not found for position: ${position}. Check if the corresponding <div> exists in the HTML.`);
    }
  });
}

renderSSCPositions();
