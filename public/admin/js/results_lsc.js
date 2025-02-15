async function renderLSCPositions(selectedCollege) {
  try {
    const response = await fetch("/developer/vote-counts");
    const data = await response.json();

    if (!data.success) {
      throw new Error("Failed to fetch vote counts");
    }

    const results = {};

    // Organize data by college and position
    data.results.forEach((candidate) => {
      const match = candidate.position.match(/(.*) - (.*)/);
      if (!match) return; // Ignore SSC positions
      const position = match[1].trim();
      const college = match[2].trim();

      if (!results[college]) {
        results[college] = {};
      }

      if (!results[college][position]) {
        results[college][position] = { candidates: [], abstain: 0 };
      }

      if (candidate.candidate === "Abstain") {
        results[college][position].abstain = candidate.votes;
      } else {
        results[college][position].candidates.push({
          name: candidate.candidate,
          votes: candidate.votes,
        });
      }
    });

    renderResultsLSC(results[selectedCollege] || {}, selectedCollege);
  } catch (error) {
    console.error("Error fetching LSC vote counts:", error);
  }
}

function renderResultsLSC(results, college) {
  const container = document.getElementById("lsc-container");
  container.innerHTML = `<h2>${college}</h2>`;

  Object.keys(results).forEach((position) => {
    const positionDiv = document.createElement("div");
    positionDiv.classList.add("position-container");
    positionDiv.innerHTML = `<h3>${position}</h3>`;

    results[position].candidates.forEach((candidate) => {
      const candidateDiv = document.createElement("div");
      candidateDiv.classList.add("progress-element");

      const nameElement = document.createElement("p");
      nameElement.classList.add("progress-label");
      nameElement.textContent = `${candidate.name}`;

      const progressBar = document.createElement("progress");
      progressBar.max = 100;
      progressBar.value = candidate.votes;

      const voteCount = document.createElement("span");
      voteCount.textContent = `${candidate.votes} votes`;

      candidateDiv.appendChild(nameElement);
      candidateDiv.appendChild(progressBar);
      candidateDiv.appendChild(voteCount);
      positionDiv.appendChild(candidateDiv);
    });

    // Render Abstain votes
    if (results[position].abstain > 0) {
      const abstainDiv = document.createElement("div");
      abstainDiv.classList.add("progress-element");

      const abstainLabel = document.createElement("p");
      abstainLabel.classList.add("progress-label");
      abstainLabel.textContent = "Abstain";

      const abstainProgressBar = document.createElement("progress");
      abstainProgressBar.max = 100;
      abstainProgressBar.value = results[position].abstain;

      const abstainCount = document.createElement("span");
      abstainCount.textContent = `${results[position].abstain} votes`;

      abstainDiv.appendChild(abstainLabel);
      abstainDiv.appendChild(abstainProgressBar);
      abstainDiv.appendChild(abstainCount);
      positionDiv.appendChild(abstainDiv);
    }

    container.appendChild(positionDiv);
  });
}

// Listen for college selection change
document.getElementById("college-selector").addEventListener("change", function () {
  renderLSCPositions(this.value);
});

// Initial fetch
renderLSCPositions("CAFA");
