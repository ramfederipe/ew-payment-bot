const { useEffect, useMemo, useRef, useState } = React;

function WalletHealthApp() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState("");
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [filters, setFilters] = useState({
    search: "",
    excludeOwner: "",
    walletType: "",
    teamLeader: "",
    agentGroup: "",
    accountType: "",
    condition: "",
    status: "",
    availableSide: "deposit",
    appVersion: ""
  });
  const [targetVersion, setTargetVersion] = useState("");
  const [oldAppOnly, setOldAppOnly] = useState(false);
  const fileRef = useRef(null);

  async function loadWalletHealth() {
    setLoading(true);

    try {
      const res = await fetch("/api/wallet-health", { credentials: "include" });
      const data = await res.json();
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
      showWalletToast("Failed to load wallet health", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadWalletHealth();
    window.loadWalletHealthApp = loadWalletHealth;

    return () => {
      if (window.loadWalletHealthApp === loadWalletHealth) {
        delete window.loadWalletHealthApp;
      }
    };
  }, []);

  const options = useMemo(() => ({
    walletTypes: unique(rows.map(row => row.walletType)),
    teamLeaders: unique(rows.map(row => row.teamLeader)),
    agentGroups: unique(rows.map(row => row.agentGroup)),
    accountTypes: unique(rows.map(row => row.accountType)),
    conditions: unique(rows.map(row => row.appCondition)),
    statuses: unique(rows.flatMap(row => [row.depositStatus, row.withdrawalStatus])),
    appVersions: uniqueVersions(rows.map(row => row.appVersion))
  }), [rows]);

  useEffect(() => {
    if (!targetVersion && options.appVersions.length) {
      setTargetVersion(options.appVersions[0]);
    }
  }, [options.appVersions, targetVersion]);

  const filteredRows = useMemo(() => {
    const query = filters.search.trim().toLowerCase();
    const excludedOwnerTerms = filters.excludeOwner
      .split(",")
      .map(term => term.trim().toLowerCase())
      .filter(Boolean);

    return rows.filter(row => {
      const ownerName = String(row.ownerName || "").toLowerCase();
      const searchable = [
        row.walletId,
        row.ownerName,
        row.deviceName,
        row.deviceId,
        row.agentGroup
      ].join(" ").toLowerCase();

      if (query && !searchable.includes(query)) return false;
      if (excludedOwnerTerms.length && excludedOwnerTerms.some(term => ownerName.includes(term))) return false;
      if (filters.walletType && row.walletType !== filters.walletType) return false;
      if (filters.teamLeader && row.teamLeader !== filters.teamLeader) return false;
      if (filters.agentGroup && row.agentGroup !== filters.agentGroup) return false;
      if (filters.accountType && row.accountType !== filters.accountType) return false;
      if (filters.condition && row.appCondition !== filters.condition) return false;
      if (filters.status) {
        const filterStatus = normalize(filters.status);

        if (filterStatus === "AVAILABLE") {
          const depositAvailable = normalize(row.depositStatus) === "AVAILABLE";
          const withdrawalAvailable = normalize(row.withdrawalStatus) === "AVAILABLE";

          if (filters.availableSide === "both" && (!depositAvailable || !withdrawalAvailable)) return false;
          if (filters.availableSide === "withdrawal" && !withdrawalAvailable) return false;
          if (filters.availableSide !== "withdrawal" && filters.availableSide !== "both" && !depositAvailable) return false;
        } else if (
          normalize(row.depositStatus) !== filterStatus &&
          normalize(row.withdrawalStatus) !== filterStatus
        ) {
          return false;
        }
      }
      if (filters.appVersion && row.appVersion !== filters.appVersion) return false;
      if (oldAppOnly && !isOldAppVersion(row.appVersion, targetVersion)) return false;

      return true;
    });
  }, [rows, filters, oldAppOnly, targetVersion]);

  const selectedFilteredIds = useMemo(
    () => filteredRows.filter(row => selectedIds.has(row.id)).map(row => row.id),
    [filteredRows, selectedIds]
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [filters]);

  const stats = useMemo(() => {
    const healthy = filteredRows.filter(row => normalize(row.appCondition) === "HEALTHY").length;
    const delayed = filteredRows.filter(row => normalize(row.appCondition) === "SYNC_DELAYED").length;
    const offline = filteredRows.filter(row => normalize(row.appCondition) === "APP_OFFLINE").length;
    const unavailable = filteredRows.filter(row =>
      normalize(row.depositStatus) !== "AVAILABLE" ||
      normalize(row.withdrawalStatus) !== "AVAILABLE"
    ).length;
    const oldApp = filteredRows.filter(row => isOldAppVersion(row.appVersion, targetVersion)).length;

    return { total: filteredRows.length, healthy, delayed, offline, unavailable, oldApp };
  }, [filteredRows, targetVersion]);

  async function uploadFile() {
    const file = fileRef.current?.files?.[0];

    if (!file) {
      showWalletToast("Choose a wallet health CSV first", "warning");
      return;
    }

    setUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/upload-wallet-health", {
        method: "POST",
        body: formData,
        credentials: "include"
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.message || "Upload failed");
      }

      if (fileRef.current) fileRef.current.value = "";
      setSelectedIds(new Set());
      showWalletToast(`Uploaded ${data.total} wallet health rows`, "success");
      await loadWalletHealth();
    } catch (err) {
      console.error(err);
      showWalletToast(err.message || "Upload failed", "error");
    } finally {
      setUploading(false);
    }
  }

  async function resetHealthData() {
    if (!confirm("Delete all Wallet Health data?")) return;

    setLoading(true);

    try {
      const res = await fetch("/api/wallet-health/reset", {
        method: "DELETE",
        credentials: "include"
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.message || "Reset failed");
      }

      setRows([]);
      setSelectedIds(new Set());
      showWalletToast(`Deleted ${data.deleted} wallet health rows`, "success");
    } catch (err) {
      console.error(err);
      showWalletToast(err.message || "Reset failed", "error");
    } finally {
      setLoading(false);
    }
  }

  async function sendGroup(agentGroup = filters.agentGroup) {
    if (!agentGroup) {
      showWalletToast("Select an Agent Group before sending", "warning");
      return;
    }

    setSending(agentGroup);

    try {
      const res = await fetch("/api/wallet-health/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ agentGroup })
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.message || "Telegram send failed");
      }

      showWalletToast(`Sent ${data.total} rows to ${agentGroup}`, "success");
    } catch (err) {
      console.error(err);
      showWalletToast(err.message || "Telegram send failed", "error");
    } finally {
      setSending("");
    }
  }

  async function sendSelectedNotice(messageType = "health_report") {
    const rowIds = selectedFilteredIds;
    const noticeLabels = {
      health_report: "relog notice",
      permission: "permission notice"
    };
    const noticeLabel = noticeLabels[messageType] || "wallet notice";

    if (rowIds.length === 0) {
      showWalletToast("Select rows before sending", "warning");
      return;
    }

    setSending(noticeLabel);

    try {
      const res = await fetch("/api/wallet-health/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ rowIds, messageType })
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.message || "Telegram send failed");
      }

      const missing = data.missingGroups?.length
        ? ` Missing Chat ID: ${data.missingGroups.join(", ")}`
        : "";

      showWalletToast(`Sent ${noticeLabel} for ${data.total} selected rows to ${data.groups} groups.${missing}`, "success");
      setSelectedIds(new Set());
    } catch (err) {
      console.error(err);
      showWalletToast(err.message || "Telegram send failed", "error");
    } finally {
      setSending("");
    }
  }

  async function sendOldAppNotice() {
    const selectedRows = selectedFilteredIds.length
      ? filteredRows.filter(row => selectedIds.has(row.id))
      : filteredRows;
    const rowIds = selectedRows
      .filter(row => isOldAppVersion(row.appVersion, targetVersion))
      .map(row => row.id);

    if (!targetVersion.trim()) {
      showWalletToast("Set the latest App Ver before sending", "warning");
      return;
    }

    if (rowIds.length === 0) {
      showWalletToast("No old app version rows found for this filter", "warning");
      return;
    }

    setSending("old app notice");

    try {
      const res = await fetch("/api/wallet-health/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          rowIds,
          messageType: "app_update",
          latestVersion: targetVersion.trim()
        })
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.message || "Telegram send failed");
      }

      const missing = data.missingGroups?.length
        ? ` Missing Chat ID: ${data.missingGroups.join(", ")}`
        : "";

      showWalletToast(`Sent old app notice for ${data.total} rows to ${data.groups} groups.${missing}`, "success");
      if (selectedFilteredIds.length) setSelectedIds(new Set());
    } catch (err) {
      console.error(err);
      showWalletToast(err.message || "Telegram send failed", "error");
    } finally {
      setSending("");
    }
  }

  function toggleRow(id) {
    setSelectedIds(previous => {
      const next = new Set(previous);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  }

  function toggleVisibleRows(visibleRows) {
    setSelectedIds(previous => {
      const next = new Set(previous);
      const visibleIds = visibleRows.map(row => row.id);
      const allSelected = visibleIds.length > 0 && visibleIds.every(id => next.has(id));

      visibleIds.forEach(id => {
        if (allSelected) {
          next.delete(id);
        } else {
          next.add(id);
        }
      });

      return next;
    });
  }

  const visibleGroups = useMemo(() => {
    const map = new Map();

    filteredRows.forEach(row => {
      const key = row.agentGroup || "No Agent Group";
      const current = map.get(key) || { total: 0, bad: 0 };
      current.total += 1;

      if (
        normalize(row.appCondition) !== "HEALTHY" ||
        normalize(row.depositStatus) !== "AVAILABLE" ||
        normalize(row.withdrawalStatus) !== "AVAILABLE" ||
        isOldAppVersion(row.appVersion, targetVersion)
      ) {
        current.bad += 1;
      }

      map.set(key, current);
    });

    return Array.from(map.entries())
      .map(([agentGroup, value]) => ({ agentGroup, ...value }))
      .sort((a, b) => b.bad - a.bad || a.agentGroup.localeCompare(b.agentGroup))
      .slice(0, 8);
  }, [filteredRows, targetVersion]);

  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const visibleRows = filteredRows.slice(pageStart, pageStart + pageSize);
  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every(row => selectedIds.has(row.id));

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  return (
    <div className="wallet-health">
      <style>{walletHealthCss}</style>

      <div className="wh-header">
        <div>
          <span className="wh-kicker">Wallet App Health</span>
          <h2>Active Device Monitor</h2>
          <p>Upload the health CSV, review device condition, then send a clean text report to Telegram by Agent Group.</p>
        </div>

        <div className="wh-upload">
          <input ref={fileRef} type="file" accept=".csv" />
          <button onClick={uploadFile} disabled={uploading}>
            {uploading ? "Uploading..." : "Upload Health CSV"}
          </button>
          <button className="danger" onClick={resetHealthData} disabled={loading}>
            Reset
          </button>
          <button className="secondary" onClick={loadWalletHealth} disabled={loading}>
            {loading ? "Loading..." : "Reload"}
          </button>
        </div>
      </div>

      <div className="wh-stats">
        <StatCard label="Total Active Rows" value={stats.total} tone="ink" />
        <StatCard label="Healthy" value={stats.healthy} tone="green" />
        <StatCard label="Sync Delayed" value={stats.delayed} tone="amber" />
        <StatCard label="App Offline" value={stats.offline} tone="red" />
        <StatCard label="Unavailable DP/WD" value={stats.unavailable} tone="blue" />
        <StatCard label={`Old App${targetVersion ? ` < ${targetVersion}` : ""}`} value={stats.oldApp} tone="purple" />
      </div>

      <div className="wh-panel">
        <div className="wh-filters">
          <input
            value={filters.search}
            onChange={event => setFilters({ ...filters, search: event.target.value })}
            placeholder="Search wallet, owner, device, group"
          />
          <input
            value={filters.excludeOwner}
            onChange={event => setFilters({ ...filters, excludeOwner: event.target.value })}
            placeholder="Exclude owner contains, e.g. test"
          />
          <Select label="Wallet Type" value={filters.walletType} options={options.walletTypes} onChange={walletType => setFilters({ ...filters, walletType })} />
          <Select label="Team Leader" value={filters.teamLeader} options={options.teamLeaders} onChange={teamLeader => setFilters({ ...filters, teamLeader })} />
          <Select label="Agent Group" value={filters.agentGroup} options={options.agentGroups} onChange={agentGroup => setFilters({ ...filters, agentGroup })} />
          <Select label="Account Type" value={filters.accountType} options={options.accountTypes} onChange={accountType => setFilters({ ...filters, accountType })} />
          <Select label="App Ver" value={filters.appVersion} options={options.appVersions} onChange={appVersion => setFilters({ ...filters, appVersion })} />
          <Select label="Condition" value={filters.condition} options={options.conditions} onChange={condition => setFilters({ ...filters, condition })} />
          <div className="wh-status-filter">
            <Select
              label="Status"
              value={filters.status}
              options={options.statuses}
              onChange={status => setFilters({
                ...filters,
                status,
                availableSide: normalize(status) === "AVAILABLE"
                  ? filters.availableSide || "deposit"
                  : filters.availableSide
              })}
            />
            {normalize(filters.status) === "AVAILABLE" && (
              <div className="wh-available-toggle">
                <span>Available</span>
                <button
                  type="button"
                  className={!filters.availableSide || filters.availableSide === "deposit" ? "active" : ""}
                  onClick={() => setFilters({ ...filters, availableSide: "deposit" })}
                >
                  Deposit
                </button>
                <button
                  type="button"
                  className={filters.availableSide === "withdrawal" ? "active" : ""}
                  onClick={() => setFilters({ ...filters, availableSide: "withdrawal" })}
                >
                  Withdrawal
                </button>
                <button
                  type="button"
                  className={filters.availableSide === "both" ? "active" : ""}
                  onClick={() => setFilters({ ...filters, availableSide: "both" })}
                >
                  Both
                </button>
              </div>
            )}
          </div>
          <button className="ghost" onClick={() => { setFilters({ search: "", excludeOwner: "", walletType: "", teamLeader: "", agentGroup: "", accountType: "", condition: "", status: "", availableSide: "deposit", appVersion: "" }); setOldAppOnly(false); }}>
            Clear
          </button>
        </div>

        <div className="wh-version-tools">
          <label>
            Latest App Ver
            <input
              value={targetVersion}
              onChange={event => setTargetVersion(event.target.value)}
              placeholder="Example: 2.0.9"
            />
          </label>
          <button className={oldAppOnly ? "active" : ""} onClick={() => setOldAppOnly(value => !value)}>
            {oldAppOnly ? "Showing Old App Only" : "Filter Old App"}
          </button>
          <span>{stats.oldApp} wallet{stats.oldApp === 1 ? "" : "s"} below latest version</span>
        </div>

        <div className="wh-sendbar">
          <div>
            <b>Telegram mapping</b>
            <span>Checked rows send only selected wallets. Old App Notice uses checked rows, or the current filtered old-app rows if nothing is checked.</span>
          </div>
          <button className="primary" onClick={() => sendSelectedNotice("health_report")} disabled={selectedFilteredIds.length === 0 || Boolean(sending)}>
            {sending === "relog notice" ? "Sending relog..." : `Send Relog Notice (${selectedFilteredIds.length})`}
          </button>
          <button className="info" onClick={() => sendSelectedNotice("permission")} disabled={selectedFilteredIds.length === 0 || Boolean(sending)}>
            {sending === "permission notice" ? "Sending permission..." : `Send Permission Notice (${selectedFilteredIds.length})`}
          </button>
          <button className="warning" onClick={sendOldAppNotice} disabled={!targetVersion.trim() || stats.oldApp === 0 || Boolean(sending)}>
            {sending === "old app notice" ? "Sending notice..." : "Send Old App Notice"}
          </button>
          <button className="secondary" onClick={() => sendGroup()} disabled={!filters.agentGroup || Boolean(sending)}>
            {sending ? `Sending ${sending}...` : "Send Filtered Group"}
          </button>
        </div>
      </div>

      <div className="wh-groups">
        {visibleGroups.map(group => (
          <button
            key={group.agentGroup}
            className="wh-group"
            onClick={() => sendGroup(group.agentGroup)}
            disabled={Boolean(sending)}
          >
            <span>{group.agentGroup}</span>
            <small>{group.total} wallets / {group.bad} issues</small>
          </button>
        ))}
      </div>

      <div className="wh-pagination">
        <span>
          Showing {filteredRows.length ? pageStart + 1 : 0}-{Math.min(pageStart + pageSize, filteredRows.length)} of {filteredRows.length}
        </span>
        <div>
          <button className="secondary" onClick={() => setCurrentPage(1)} disabled={safePage === 1}>
            First
          </button>
          <button className="secondary" onClick={() => setCurrentPage(page => Math.max(1, page - 1))} disabled={safePage === 1}>
            Prev
          </button>
          <b>Page {safePage} / {totalPages}</b>
          <button className="secondary" onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))} disabled={safePage === totalPages}>
            Next
          </button>
          <button className="secondary" onClick={() => setCurrentPage(totalPages)} disabled={safePage === totalPages}>
            Last
          </button>
        </div>
      </div>

      <div className="wh-table-wrap">
        <table className="wh-table">
          <thead>
            <tr>
              <th className="wh-check">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={() => toggleVisibleRows(visibleRows)}
                />
              </th>
              <th>Wallet</th>
              <th>Account</th>
              <th>Status</th>
              <th>Owner</th>
              <th>Team / Group</th>
              <th>Condition</th>
              <th>Deposit</th>
              <th>Withdrawal</th>
              <th>API Balance</th>
              <th>Device</th>
              <th>App Ver</th>
              <th>SMS</th>
              <th>Listener</th>
              <th>App Noti</th>
              <th>Full Screen</th>
              <th>Battery</th>
              <th>Last Active</th>
              <th>API Fails</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(row => (
              <tr key={row.id} className={selectedIds.has(row.id) ? "selected" : ""}>
                <td className="wh-check">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(row.id)}
                    onChange={() => toggleRow(row.id)}
                  />
                </td>
                <td><b>{row.walletId || "-"}</b><small>{row.walletType || "-"}</small></td>
                <td><Pill value={row.accountType} /></td>
                <td><Pill value={row.walletActive} /></td>
                <td><b>{row.ownerName || "-"}</b><small>PA #{row.personalAccountId || "-"}</small></td>
                <td><b>{row.teamLeader || "-"}</b><small>{row.agentGroup || "-"}</small></td>
                <td><Condition row={row} /></td>
                <td><Pill value={row.depositStatus} /></td>
                <td><Pill value={row.withdrawalStatus} /></td>
                <td className="wh-money">{formatWalletAmount(row.apiBalance)}</td>
                <td><b>{row.deviceName || "-"}</b><small>{row.deviceId || "-"}</small></td>
                <td>{row.appVersion || "-"}</td>
                <td><Pill value={row.smsPermission} /></td>
                <td><Pill value={row.notificationListener} /></td>
                <td><Pill value={row.appNotifications} /></td>
                <td><Pill value={row.fullScreenAlert} /></td>
                <td><Pill value={row.batteryOptimizationDisabled} /></td>
                <td>{row.lastActive || "-"}</td>
                <td><Pill value={String(row.apiFailures ?? 0)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="wh-footnote">50 rows per page. Header checkbox selects this page only.</div>
    </div>
  );
}

function StatCard({ label, value, tone }) {
  return (
    <div className={`wh-stat ${tone}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function Select({ label, value, options, onChange }) {
  return (
    <select value={value} onChange={event => onChange(event.target.value)}>
      <option value="">{label}</option>
      {options.map(option => <option key={option} value={option}>{option}</option>)}
    </select>
  );
}

function Pill({ value }) {
  const text = value || "-";
  const token = normalize(text).replace(/[^A-Z0-9]+/g, "-").toLowerCase() || "blank";
  const className = `wh-pill wh-pill-${token}`;
  return <span className={className}>{text}</span>;
}

function formatWalletAmount(value) {
  const amount = Number(value || 0);
  return amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function Condition({ row }) {
  return (
    <div className="wh-condition">
      <Pill value={row.appCondition} />
      <small className={normalize(row.appCondition) === "SYNC_DELAYED" ? "warning" : ""}>
        {row.lastApiFailReason || "No active issue"}
      </small>
    </div>
  );
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function uniqueVersions(values) {
  return Array.from(new Set(values.filter(Boolean)))
    .sort((a, b) => compareVersions(b, a) || String(b).localeCompare(String(a)));
}

function isOldAppVersion(currentVersion, latestVersion) {
  if (!String(latestVersion || "").trim()) return false;
  if (!String(currentVersion || "").trim()) return true;
  return compareVersions(currentVersion, latestVersion) < 0;
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] || 0;
    const rightValue = rightParts[index] || 0;
    if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
  }

  return 0;
}

function parseVersion(value) {
  return String(value || "")
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(part => Number(part));
}

function normalize(value) {
  return String(value || "").trim().toUpperCase();
}

function showWalletToast(message, type) {
  if (typeof window.showToast === "function") {
    window.showToast(message, type);
    return;
  }

  alert(message);
}

const walletHealthCss = `
.wallet-health {
  color: #0f172a;
  display: grid;
  gap: 14px;
  font-size: 15px;
}
.wh-header {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: flex-start;
  padding: 22px 24px;
  border: 1px solid #d8e1ec;
  background: #ffffff;
  border-radius: 8px;
  box-shadow: 0 12px 28px rgba(15, 23, 42, .07);
}
.wh-kicker {
  display: inline-flex;
  color: #2563eb;
  font-weight: 850;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: .06em;
  margin-bottom: 6px;
}
.wh-header h2 {
  margin: 0;
  color: #0f172a;
  font-size: 30px;
  font-weight: 850;
  letter-spacing: 0;
}
.wh-header p {
  margin: 7px 0 0;
  color: #52627a;
  max-width: 720px;
  font-size: 15px;
  line-height: 1.5;
}
.wh-upload {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) auto auto auto;
  gap: 10px;
  align-items: center;
}
.wh-upload input,
.wh-filters input,
.wh-filters select,
.wh-version-tools input {
  border: 1px solid #b8c5d6;
  background: #fff;
  border-radius: 6px;
  height: 42px;
  padding: 0 12px;
  font-size: 14px;
  font-weight: 650;
  min-width: 0;
}
.wh-upload button,
.wh-sendbar button,
.wh-pagination button,
.wh-group,
.wh-filters .ghost,
.wh-version-tools button {
  border: 0;
  background: #111827;
  color: #fff;
  border-radius: 6px;
  min-height: 42px;
  padding: 0 16px;
  font-weight: 850;
  font-size: 13px;
  white-space: nowrap;
}
.wh-sendbar button.primary { background: #15803d; }
.wh-sendbar button.info { background: #2563eb; }
.wh-sendbar button.warning { background: #f59e0b; color: #111827; }
.wh-sendbar button.secondary,
.wh-pagination button.secondary,
.wh-upload .secondary,
.wh-filters .ghost {
  background: #e5ebf3;
  color: #0f172a;
}
.wh-upload .danger { background: #dc2626; color: #fff; }
.wh-stats {
  display: grid;
  grid-template-columns: repeat(6, minmax(160px, 1fr));
  gap: 12px;
}
.wh-stat {
  border-radius: 8px;
  padding: 16px 17px;
  background: #fff;
  border: 1px solid #d8e1ec;
  box-shadow: 0 8px 22px rgba(15, 23, 42, .055);
}
.wh-stat span {
  display: block;
  color: #53657c;
  font-size: 13px;
  font-weight: 850;
}
.wh-stat b {
  display: block;
  margin-top: 7px;
  color: #111827;
  font-size: 30px;
  line-height: 1;
}
.wh-stat.green { border-left: 5px solid #10b981; }
.wh-stat.amber { border-left: 5px solid #f59e0b; }
.wh-stat.red { border-left: 5px solid #ef4444; }
.wh-stat.blue { border-left: 5px solid #0ea5e9; }
.wh-stat.ink { border-left: 5px solid #111827; }
.wh-stat.purple { border-left: 5px solid #7c3aed; }
.wh-panel {
  background: #fff;
  border: 1px solid #d8e1ec;
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 8px 22px rgba(15, 23, 42, .055);
}
.wh-filters {
  display: grid;
  grid-template-columns: minmax(230px, 1.3fr) minmax(220px, 1fr) repeat(7, minmax(140px, 1fr)) auto;
  gap: 10px;
}
.wh-status-filter {
  display: grid;
  gap: 6px;
}
.wh-status-filter select {
  width: 100%;
}
.wh-available-toggle {
  display: grid;
  grid-template-columns: auto 1fr 1fr 1fr;
  gap: 4px;
  align-items: center;
}
.wh-available-toggle span {
  color: #475569;
  font-size: 11px;
  font-weight: 850;
}
.wh-available-toggle button {
  border: 1px solid #cbd5e1;
  background: #f8fafc;
  color: #334155;
  border-radius: 6px;
  min-height: 28px;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 850;
}
.wh-available-toggle button.active {
  border-color: #16a34a;
  background: #dcfce7;
  color: #166534;
}
.wh-version-tools {
  display: flex;
  align-items: end;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding: 12px;
  background: #f7f9fc;
  border: 1px solid #d8e1ec;
  border-radius: 8px;
}
.wh-version-tools label {
  display: grid;
  gap: 5px;
  color: #475569;
  font-size: 12px;
  font-weight: 850;
  text-transform: uppercase;
  letter-spacing: .04em;
}
.wh-version-tools input { width: 160px; }
.wh-version-tools button { background: #4f46e5; }
.wh-version-tools button.active { background: #111827; }
.wh-version-tools span {
  color: #52627a;
  font-size: 14px;
  font-weight: 800;
}
.wh-sendbar {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) auto auto auto auto;
  gap: 10px;
  align-items: center;
  margin-top: 12px;
  padding: 12px;
  background: #f7f9fc;
  border: 1px solid #d8e1ec;
  border-radius: 8px;
}
.wh-sendbar b {
  display: block;
  color: #0f172a;
  font-size: 15px;
  margin-bottom: 2px;
}
.wh-sendbar span {
  display: block;
  color: #53657c;
  font-size: 13px;
  line-height: 1.4;
}
.wh-groups {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px;
}
.wh-group {
  height: auto;
  text-align: left;
  padding: 14px;
  background: #10233f;
  border: 1px solid #17365d;
}
.wh-group span {
  display: block;
  font-size: 14px;
  font-weight: 900;
}
.wh-group small {
  display: block;
  color: #bfdbfe;
  margin-top: 5px;
  font-size: 12px;
}
.wh-pagination {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: #fff;
  border: 1px solid #d8e1ec;
  border-radius: 8px;
  box-shadow: 0 8px 22px rgba(15, 23, 42, .055);
}
.wh-pagination span {
  color: #475569;
  font-size: 14px;
  font-weight: 850;
}
.wh-pagination div {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wh-pagination b {
  color: #0f172a;
  font-size: 14px;
  white-space: nowrap;
}
.wh-table-wrap {
  overflow: auto;
  max-height: 64vh;
  background: #fff;
  border: 1px solid #d8e1ec;
  border-radius: 8px;
  box-shadow: 0 14px 30px rgba(15, 23, 42, .075);
}
.wh-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 15px;
  min-width: 1740px;
}
.wh-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #f3f6fa;
  color: #0f172a;
  padding: 13px 12px;
  border-bottom: 1px solid #ccd7e6;
  text-align: left;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 900;
}
.wh-table td {
  padding: 14px 12px;
  border-bottom: 1px solid #edf2f7;
  vertical-align: top;
  line-height: 1.38;
  color: #111827;
}
.wh-table tbody tr:hover td { background: #f8fbff; }
.wh-table tr.selected td { background: #eaf3ff; }
.wh-table b {
  display: block;
  font-size: 15px;
  font-weight: 850;
}
.wh-table small {
  display: block;
  color: #64748b;
  margin-top: 4px;
  max-width: 260px;
  font-size: 13px;
  line-height: 1.35;
}
.wh-money {
  font-weight: 900;
  color: #0f172a;
  white-space: nowrap;
}
.wh-pill {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  min-height: 26px;
  padding: 0 11px;
  background: #e5ebf3;
  color: #334155;
  font-weight: 850;
  font-size: 12px;
  white-space: nowrap;
}
.wh-pill-active,
.wh-pill-yes,
.wh-pill-available,
.wh-pill-healthy,
.wh-pill-0 {
  background: #d1fae5;
  color: #047857;
}
.wh-pill-inactive,
.wh-pill-unavailable,
.wh-pill-app-offline,
.wh-pill-no-active-device {
  background: #fee2e2;
  color: #b91c1c;
}
.wh-pill-permission-missing {
  background: #ede9fe;
  color: #5b21b6;
}
.wh-pill-sync-delayed {
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #f59e0b;
}
.wh-condition { min-width: 250px; }
.wh-condition .warning {
  color: #92400e;
  font-weight: 800;
}
.wh-check {
  width: 46px;
  min-width: 46px;
  text-align: center;
}
.wh-check input {
  width: 18px;
  height: 18px;
  cursor: pointer;
}
.wh-footnote {
  margin-top: 2px;
  color: #64748b;
  font-size: 13px;
}
body.dark-theme .wallet-health { color: #e5e7eb; }
body.dark-theme .wh-header,
body.dark-theme .wh-stat,
body.dark-theme .wh-panel,
body.dark-theme .wh-version-tools,
body.dark-theme .wh-sendbar,
body.dark-theme .wh-pagination,
body.dark-theme .wh-table-wrap {
  background: #111827;
  color: #e5e7eb;
  border-color: #263244;
  box-shadow: 0 14px 32px rgba(0, 0, 0, .24);
}
body.dark-theme .wh-header h2,
body.dark-theme .wh-sendbar b,
body.dark-theme .wh-stat b,
body.dark-theme .wh-pagination b,
body.dark-theme .wh-table b {
  color: #f8fafc;
}
body.dark-theme .wh-header p,
body.dark-theme .wh-stat span,
body.dark-theme .wh-sendbar span,
body.dark-theme .wh-version-tools span,
body.dark-theme .wh-version-tools label,
body.dark-theme .wh-pagination span,
body.dark-theme .wh-table small,
body.dark-theme .wh-footnote {
  color: #a8b7ca;
}
body.dark-theme .wh-upload input,
body.dark-theme .wh-filters input,
body.dark-theme .wh-version-tools input,
body.dark-theme .wh-filters select {
  background: #0b1220;
  color: #e5e7eb;
  border-color: #334155;
}
body.dark-theme .wh-upload .secondary,
body.dark-theme .wh-filters .ghost,
body.dark-theme .wh-sendbar button.secondary,
body.dark-theme .wh-pagination button.secondary {
  background: #263244;
  color: #e5e7eb;
}
body.dark-theme .wh-table th {
  background: #172033;
  color: #e5e7eb;
  border-color: #263244;
}
body.dark-theme .wh-table td {
  border-color: #263244;
  color: #e5e7eb;
}
body.dark-theme .wh-table tbody tr:hover td { background: #162034; }
body.dark-theme .wh-table tr.selected td { background: #0f1f3b; }
body.dark-theme .wh-pill { background: #263244; color: #dbeafe; }
button:disabled {
  opacity: .55;
  cursor: not-allowed;
}
@media (max-width: 1300px) {
  .wh-header,
  .wh-sendbar,
  .wh-pagination {
    flex-direction: column;
    align-items: stretch;
  }
  .wh-sendbar {
    grid-template-columns: 1fr;
  }
  .wh-pagination div {
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .wh-upload,
  .wh-filters,
  .wh-stats {
    grid-template-columns: 1fr;
  }
}
`;

const walletHealthRoot = document.getElementById("walletHealthRoot");

if (walletHealthRoot) {
  ReactDOM.createRoot(walletHealthRoot).render(<WalletHealthApp />);
}
