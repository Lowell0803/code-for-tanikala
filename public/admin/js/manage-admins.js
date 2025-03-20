// Delete admin account functionality
document.querySelectorAll(".button-cancel").forEach((button) => {
  button.addEventListener("click", () => {
    const row = button.closest("tr");
    const id = row.getAttribute("data-id");

    // If the ObjectID is the developer's ID, alert and exit without confirmation.
    if (id === "67c311956f9fff1e2b6ba809") {
      alert("It's ironic you are trying to delete me as 'developer' lol.");
      return;
    }

    // Prevent deletion if trying to delete the logged in account
    if (username === "<%= loggedInAdmin.email %>") {
      alert("You cannot delete your own account.");
      return;
    }

    // Otherwise, ask for deletion confirmation.
    if (confirm("Are you sure you want to delete this admin account?")) {
      const username = row.getAttribute("data-email");
      const formData = new FormData();
      formData.append("username", username);

      fetch("/admin-accounts/delete", {
        method: "POST",
        body: formData,
      })
        .then((response) => {
          if (response.ok) {
            window.location.reload();
          } else {
            alert("Unable to delete admin account.");
          }
        })
        .catch((err) => {
          console.error("Error deleting admin account:", err);
          alert("An error occurred.");
        });
    }
  });
});

// Inside your edit button click handler
document.querySelectorAll(".button-edit").forEach((button) => {
  button.addEventListener("click", () => {
    const row = button.closest("tr");
    const adminId = row.getAttribute("data-id");
    const loggedInAdminId = "<%= loggedInAdmin.key %>"; // Make sure this is available

    // If the admin to be edited is the protected developer and the logged in admin is not that account, prevent editing.
    if (adminId === "67c311956f9fff1e2b6ba809" && loggedInAdminId !== "67c311956f9fff1e2b6ba809") {
      alert("You are not allowed to edit this account.");
      return;
    }

    // Continue with the normal edit process...
    document.getElementById("edit-id").value = adminId;
    document.getElementById("edit-name").value = row.getAttribute("data-name");
    document.getElementById("edit-email").value = row.getAttribute("data-email");
    document.getElementById("edit-role").value = row.getAttribute("data-role");
    document.getElementById("edit-status-display").value = row.getAttribute("data-status");
    document.getElementById("edit-password").value = row.getAttribute("data-password");
    const imgSrc = row.getAttribute("data-img");
    document.getElementById("edit-img-preview").src = imgSrc;
    document.getElementById("edit-imgBase64").value = imgSrc;
    editModal.style.display = "block";
  });
});
