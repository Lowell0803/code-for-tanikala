function toggleButton() {
  const checkbox = document.getElementById("agreement");
  const button = document.getElementById("proceedBtn");
  button.disabled = !checkbox.checked; // Enable when checked, disable when unchecked
}
