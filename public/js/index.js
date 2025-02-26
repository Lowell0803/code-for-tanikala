// FOOTER
function updateDateTime() {
  var now = new Date();
  var formattedDate = now
    .toLocaleDateString("en-PH", {
      year: "numeric",
      month: "long",
      day: "numeric",
    })
    .toUpperCase();
  var formattedTime = now.toLocaleTimeString("en-PH", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Manila",
  });
  document.getElementById("datetime").innerHTML = `${formattedDate} - ${formattedTime}`;
}

updateDateTime();
setInterval(updateDateTime, 45000); // update every 45 seconds

function toggleButton() {
  const checkbox = document.getElementById("agreement");
  const button = document.getElementById("proceedBtn");
  button.disabled = !checkbox.checked; // Enable when checked, disable when unchecked
}
