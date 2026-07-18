function RoleAccess() {
  const roles = ["Developer", "Admin", "Payment", "CS", "User"];
  async function loadPermissions() {
    try {
      const res = await fetch(`/api/permissions/${selectedRole.toLowerCase()}`);
      const data = await res.json();
      if (data.success) {
        setPermissions(data.permissions || {});
      }
    } catch (err) {
      console.error("Load permissions error:", err);
    }
  }
  async function savePermissions() {
    try {
      const res = await fetch("/api/permissions/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          role: selectedRole.toLowerCase(),
          permissions
        })
      });
      const data = await res.json();
      if (data.success) {
        alert("✅ Permissions saved successfully");
      } else {
        alert("❌ Failed to save permissions");
      }
    } catch (err) {
      console.error(err);
      alert("❌ Save error");
    }
  }
  const [selectedRole, setSelectedRole] = React.useState("Admin");
  const [permissions, setPermissions] = React.useState({});
  React.useEffect(() => {
    loadPermissions();
  }, [selectedRole]);
  const permissionGroups = [{
    title: "Page Access",
    permissions: ["view_page_dashboard", "view_page_pending_deposits", "view_page_settled_deposits", "view_page_video_case", "view_page_settled_video", "view_page_sms", "view_page_chat_id", "view_page_balance", "view_page_wallet", "view_page_wallet_health", "view_page_groups", "view_page_settlement", "view_page_users", "view_page_messages", "view_page_settings"]
  }, {
    title: "Dashboard",
    permissions: ["view_dashboard", "view_stats", "view_notifications"]
  }, {
    title: "Transactions",
    permissions: ["view_transactions", "edit_transaction", "delete_transaction", "bulk_delete_transactions", "export_transactions", "approve_transactions", "reject_transactions"]
  }, {
    title: "Operations",
    permissions: ["send_telegram", "manage_chat_ids", "manage_wallets", "wallet_health", "view_groups", "sync_sheets", "view_settlements"]
  }, {
    title: "System",
    permissions: ["settings_access", "upload_credentials", "view_logs", "clear_logs", "send_logs", "reconcile_data", "reset_pending", "reset_video_cases", "manage_users", "create_users", "delete_users", "change_roles"]
  }];
  return React.createElement("div", {
    className: "card shadow border-0 rounded-4 p-4 mt-4 bg-dark text-white"
  }, React.createElement("div", {
    className: "d-flex justify-content-between align-items-center mb-4"
  }, React.createElement("div", null, React.createElement("h3", {
    className: "mb-1"
  }, "🔐 ", selectedRole, " Permissions"), React.createElement("div", {
    className: "text-secondary"
  }, "Configure system permissions per role")), React.createElement("button", {
    className: "btn btn-primary rounded-3",
    onClick: savePermissions
  }, "💾 Save Permissions")), React.createElement("div", {
    className: "row"
  }, React.createElement("div", {
    className: "col-md-3"
  }, React.createElement("div", {
    className: "d-grid gap-2"
  }, roles.map(role => React.createElement("button", {
    key: role,
    onClick: () => setSelectedRole(role),
    className: `
      btn w-100 rounded-3 text-start fw-bold

      ${selectedRole === role ? "btn-primary" : "btn-outline-light"}
    `
  }, role)))), React.createElement("div", {
    className: "col-md-9"
  }, permissionGroups.map(group => React.createElement("div", {
    key: group.title,
    className: "mb-4"
  }, React.createElement("h5", {
    className: "mb-3 border-bottom pb-2"
  }, group.title), React.createElement("div", {
    className: "row g-3"
  }, group.permissions.map(permission => React.createElement("div", {
    className: "col-md-6",
    key: permission
  }, React.createElement("div", {
    className: "permission-card"
  }, React.createElement("div", null, React.createElement("strong", null, permission.replaceAll("_", " ").replace(/\\b\\w/g, l => l.toUpperCase())), React.createElement("div", {
    className: "text-muted small"
  }, "Allow access to this feature")), React.createElement("input", {
    type: "checkbox",
    className: "form-check-input",
    checked: permissions[permission] ?? permission.startsWith("view_page_"),
    onChange: e => {
      setPermissions(prev => ({
        ...prev,
        [permission]: e.target.checked
      }));
    }
  }))))))))));
}
const root = ReactDOM.createRoot(document.getElementById("roleAccessRoot"));
root.render(React.createElement(RoleAccess, null));
