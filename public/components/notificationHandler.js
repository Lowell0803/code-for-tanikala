import { createNotification } from "/components/notification.js";

// Define a reusable function to show notifications.
function notify(message, type = "error", duration = 3000) {
  createNotification(message, type, duration);
}

// Expose the notify function globally so that other scripts can use it.
window.notify = notify;

// Check URL parameters and display notifications accordingly.
const urlParams = new URLSearchParams(window.location.search);

if (urlParams.get("logged_out") === "true") {
  notify("You have successfully logged out.", "logout", 5000);
  history.replaceState({}, document.title, window.location.pathname);
}

if (urlParams.get("logged_in") === "true") {
  notify("You have successfully logged in to your account.", "login", 5000);
  history.replaceState({}, document.title, window.location.pathname);
}

if (urlParams.get("error") === "not_registered") {
  notify("You are not eligible to vote as you are not recognized as a registered voter in this election.", "error", 5000);
  history.replaceState({}, document.title, window.location.pathname);
}

if (urlParams.get("error") === "already_voted") {
  notify("You have already voted for this election.", "error", 5000);
  history.replaceState({}, document.title, window.location.pathname);
}

// if (urlParams.has("error")) {
//   let errorMessage = "An unknown error occurred. Please try again.";
//   const errorType = urlParams.get("error");

//   if (errorType === "invalid_credentials") {
//     errorMessage = "Invalid username or password. Please try again.";
//   } else if (errorType === "server_error") {
//     errorMessage = "A server error occurred. Please try again later.";
//   }

//   notify(errorMessage, "error", 3000);
//   history.replaceState({}, document.title, window.location.pathname);
// }

if (urlParams.get("devAlert") === "votingAgain") {
  notify("You are a developer. You can vote again for testing purposes.", "info", 5000);
  history.replaceState({}, document.title, window.location.pathname);
}

if (urlParams.get("new_reg") === "true") {
  notify("You have successfully registered for voting.", "register", 5000);
  history.replaceState({}, document.title, window.location.pathname);
}

if (urlParams.get("registered") === "true") {
  notify("You have already registered for voting.", "register", 5000);
  history.replaceState({}, document.title, window.location.pathname);
}

if (urlParams.get("message_submitted") === "true") {
  notify("Your message has been submitted.", "success", 5000);
  history.replaceState({}, document.title, window.location.pathname);
}

if (urlParams.get("otp_sent") === "true") {
  notify("Check your emall for the OTP.", "email", 8000);
  history.replaceState({}, document.title, window.location.pathname);
}

if (urlParams.get("error") === "old_password_incorrect") {
  notify("Old password is incorrect!", "error", 5000);
  history.replaceState({}, document.title, window.location.pathname);
}
