import { createNotification } from "/components/notification.js";

// Define a reusable function to show notifications.
function notify(message, type = "error", duration = 3000) {
  createNotification(message, type, duration);
}

// Expose the notify function globally so that other scripts can use it.
window.notify = notify;

// Check URL parameters and display notifications accordingly.
const urlParams = new URLSearchParams(window.location.search);

if (urlParams.has("loggedOut")) {
  notify("Logged out successfully", "info", 3000);
  history.replaceState({}, document.title, window.location.pathname);
}

if (urlParams.has("error")) {
  let errorMessage = "An unknown error occurred. Please try again.";
  const errorType = urlParams.get("error");

  if (errorType === "invalid_credentials") {
    errorMessage = "Invalid username or password. Please try again.";
  } else if (errorType === "server_error") {
    errorMessage = "A server error occurred. Please try again later.";
  }

  notify(errorMessage, "error", 3000);
  history.replaceState({}, document.title, window.location.pathname);
}

if (urlParams.get("devAlert") === "votingAgain") {
  notify("You are a developer. You can vote again for testing purposes.", "info", 5000);
  history.replaceState({}, document.title, window.location.pathname);
}
