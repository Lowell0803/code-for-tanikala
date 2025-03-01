let notificationContainer;

function createNotification(message, type = "success", duration = 4000) {
  if (!notificationContainer) {
    notificationContainer = document.createElement("div");
    notificationContainer.classList.add("notification-wrapper");
    document.body.appendChild(notificationContainer);
  }

  const notification = document.createElement("div");
  notification.classList.add("notification", type);
  notification.innerHTML = `
        <div class="notification-icon">
            <i class="fa ${type === "success" ? "fa-check-circle" : "fa-exclamation-triangle"}"></i>
        </div>
        <div class="notification-message">${message}</div>
        <button class="notification-close">&times;</button>
    `;

  notificationContainer.appendChild(notification);

  // Auto-remove after duration
  setTimeout(() => {
    notification.classList.add("hide");
    setTimeout(() => notification.remove(), 500);
  }, duration);

  // Close button functionality
  notification.querySelector(".notification-close").addEventListener("click", () => {
    notification.classList.add("hide");
    setTimeout(() => notification.remove(), 500);
  });
}

// Export as a module
export { createNotification };
