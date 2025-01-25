// Fetch and render positions based on selected college
async function renderLSCPositions(collegeValue) {
    // Fetch the JSON data
    const response = await fetch('data/results_lsc.json');
    const data = await response.json();
  
    // Find the selected college's data
    const selectedCollege = data.colleges.find(college => 
      college.college.toLowerCase().includes(collegeValue.toLowerCase())
    );
  
    if (!selectedCollege) {
      console.error("College not found!");
      return;
    }
  
    // Clear existing content
    document.querySelectorAll('.container-lsc').forEach(container => {
      container.innerHTML = ''; // Clear container content
    });
  
    // Render positions and candidates for the selected college
    selectedCollege.positions.forEach(position => {
      const containerId = `container-lsc-${position.position.toLowerCase().replace(/\s+/g, '-').replace(/([a-z])([A-Z])/g, '$1-$2')}`;
      const container = document.getElementById(containerId);
  
      if (container) {
        // Create position header
        const positionTitle = document.createElement('h2');
        positionTitle.textContent = position.position;
        container.appendChild(positionTitle);
  
        const brElement = document.createElement("br");
        container.appendChild(brElement);
  
        // Render candidates
        position.candidates.forEach(candidate => {
          const candidateDiv = document.createElement('div');
          candidateDiv.classList.add('progress-element');
          candidateDiv.style.display = 'flex';
          candidateDiv.style.alignItems = 'center';
          candidateDiv.style.marginBottom = '1rem'; // Dynamic spacing
  
          // Candidate image
          const imgElement = document.createElement('img');
          imgElement.src = candidate.img;
          imgElement.alt = candidate.name;
          imgElement.style.width = '3rem'; // Dynamic size
          imgElement.style.height = '3rem';
          imgElement.style.borderRadius = '50%';
          imgElement.style.marginRight = '0.5rem'; // Dynamic margin
          candidateDiv.appendChild(imgElement);
  
          // Info container (name + partylist + progress bar)
          const infoContainer = document.createElement('div');
          infoContainer.style.flexGrow = '1';
  
          // Candidate name + partylist
          const nameElement = document.createElement('p');
          nameElement.classList.add('progress-label');
          nameElement.textContent = `${candidate.name} (${candidate.partylist || "Independent"})`;
          nameElement.style.marginBottom = '0.5rem'; // Dynamic spacing
          infoContainer.appendChild(nameElement);
  
          // Progress bar container
          const progressContainer = document.createElement('div');
          progressContainer.classList.add('progress-container');
          progressContainer.style.display = 'flex';
          progressContainer.style.alignItems = 'center';
          progressContainer.style.justifyContent = 'space-between';
  
          // Progress bar
          const progressBar = document.createElement('progress');
          progressBar.max = 100;
          progressBar.value = candidate.percentage;
          progressBar.style.flexGrow = '1'; // Stretch to available space
          progressContainer.appendChild(progressBar);
  
          // Percentage text
          const percentageText = document.createElement('span');
          percentageText.textContent = `${candidate.percentage}%`;
          percentageText.style.marginLeft = '0.5rem'; // Dynamic margin
          percentageText.style.fontWeight = 'bold';
          progressContainer.appendChild(percentageText);
  
          infoContainer.appendChild(progressContainer);
          candidateDiv.appendChild(infoContainer);
          container.appendChild(candidateDiv);
        });
  
        // Render abstain progress bar
        const abstainDiv = document.createElement('div');
        abstainDiv.classList.add('progress-element');
  
        const abstainLabel = document.createElement('p');
        abstainLabel.classList.add('progress-label');
        abstainLabel.textContent = 'Abstain';
        abstainDiv.appendChild(abstainLabel);
  
        const abstainProgressContainer = document.createElement('div');
        abstainProgressContainer.classList.add('progress-container');
        abstainProgressContainer.style.display = 'flex';
        abstainProgressContainer.style.alignItems = 'center';
        abstainProgressContainer.style.justifyContent = 'space-between';
  
        const abstainProgressBar = document.createElement('progress');
        abstainProgressBar.max = 100;
        abstainProgressBar.value = position.abstain;
        abstainProgressBar.style.flexGrow = '1'; // Stretch to available space
        abstainProgressContainer.appendChild(abstainProgressBar);
  
        const abstainPercentageText = document.createElement('span');
        abstainPercentageText.textContent = `${position.abstain}%`;
        abstainPercentageText.style.marginLeft = '0.5rem'; // Dynamic margin
        abstainPercentageText.style.fontWeight = 'bold';
        abstainProgressContainer.appendChild(abstainPercentageText);
  
        abstainDiv.appendChild(abstainProgressContainer);
        container.appendChild(abstainDiv);
      }
    });
  }
  
  // Event listener for dropdown change
  document.querySelector('select').addEventListener('change', function () {
    renderLSCPositions(this.value);
  });
  
  // Initial render for the first option
  renderLSCPositions(document.querySelector('select').value);
  