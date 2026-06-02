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
    walletType: "",
    teamLeader: "",
    agentGroup: "",
    accountType: "",
    condition: "",
    status: "",
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

    return rows.filter(row => {
      const searchable = [
        row.walletId,
        row.ownerName,
        row.deviceName,
        row.deviceId,
        row.agentGroup
      ].join(" ").toLowerCase();

      if (query && !searchable.includes(query)) return false;
      if (filters.walletType && row.walletType !== filters.walletType) return false;
      if (filters.teamLeader && row.teamLeader !== filters.teamLeader) return false;
      if (filters.agentGroup && row.agentGroup !== filters.agentGroup) return false;
      if (filters.accountType && row.accountType !== filters.accountType) return false;
      if (filters.condition && row.appCondition !== filters.condition) return false;
      if (filters.status && row.depositStatus !== filters.status && row.withdrawalStatus !== filters.status) return false;
      if (filters.appVersion && row.appVersion !== filters.appVersion) return false;
      if (oldAppOnly && !isOldAppVersion(row.appVersion, targetVersion)) return false;

      return true;
    });
  }, [rows, filters, oldAppOnly, targetVersion]);

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

  async function sendSelectedRows() {
    const rowIds = Array.from(selectedIds);

    if (rowIds.length === 0) {
      showWalletToast("Select rows before sending", "warning");
      return;
    }

    setSending("selected rows");

    try {
      const res = await fetch("/api/wallet-health/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ rowIds })
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.message || "Telegram send failed");
      }

      const missing = data.missingGroups?.length
        ? ` Missing Chat ID: ${data.missingGroups.join(", ")}`
        : "";

      showWalletToast(`Sent ${data.total} selected rows to ${data.groups} groups.${missing}`, "success");
    } catch (err) {
      console.error(err);
      showWalletToast(err.message || "Telegram send failed", "error");
    } finally {
      setSending("");
    }
  }

  async function sendOldAppNotice() {
    const selectedRows = selectedIds.size
      ? rows.filter(row => selectedIds.has(row.id))
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
          <Select label="Wallet Type" value={filters.walletType} options={options.walletTypes} onChange={walletType => setFilters({ ...filters, walletType })} />
          <Select label="Team Leader" value={filters.teamLeader} options={options.teamLeaders} onChange={teamLeader => setFilters({ ...filters, teamLeader })} />
          <Select label="Agent Group" value={filters.agentGroup} options={options.agentGroups} onChange={agentGroup => setFilters({ ...filters, agentGroup })} />
          <Select label="Account Type" value={filters.accountType} options={options.accountTypes} onChange={accountType => setFilters({ ...filters, accountType })} />
          <Select label="App Ver" value={filters.appVersion} options={options.appVersions} onChange={appVersion => setFilters({ ...filters, appVersion })} />
          <Select label="Condition" value={filters.condition} options={options.conditions} onChange={condition => setFilters({ ...filters, condition })} />
          <Select label="Status" value={filters.status} options={options.statuses} onChange={status => setFilters({ ...filters, status })} />
          <button className="ghost" onClick={() => { setFilters({ search: "", walletType: "", teamLeader: "", agentGroup: "", accountType: "", condition: "", status: "", appVersion: "" }); setOldAppOnly(false); }}>
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
          <button className="primary" onClick={sendSelectedRows} disabled={selectedIds.size === 0 || Boolean(sending)}>
            {sending === "selected rows" ? "Sending checked..." : `Send Checked Only (${selectedIds.size})`}
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
.wallet-health { color: #0f172a; }
.wh-header { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; padding: 22px; border: 1px solid #e2e8f0; background: linear-gradient(180deg, #ffffff, #f8fafc); border-radius: 8px; box-shadow: 0 12px 34px rgba(15, 23, 42, .08); }
.wh-kicker { display: inline-flex; color: #0ea5e9; font-weight: 800; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
.wh-header h2 { margin: 0; font-size: 28px; font-weight: 850; letter-spacing: 0; }
.wh-header p { margin: 6px 0 0; color: #64748b; max-width: 680px; }
.wh-upload { display: grid; grid-template-columns: minmax(220px, 1fr) auto auto auto; gap: 8px; align-items: center; }
.wh-upload input, .wh-filters input, .wh-filters select { border: 1px solid #cbd5e1; background: #fff; border-radius: 6px; height: 36px; padding: 0 10px; font-size: 13px; min-width: 0; }
.wh-upload button, .wh-sendbar button, .wh-pagination button, .wh-group, .wh-filters .ghost { border: 0; background: #0f172a; color: #fff; border-radius: 6px; height: 36px; padding: 0 14px; font-weight: 800; font-size: 12px; }
.wh-sendbar button.primary { background: #16a34a; }
.wh-sendbar button.warning { background: #f59e0b; color: #111827; }
.wh-sendbar button.secondary, .wh-pagination button.secondary { background: #e2e8f0; color: #0f172a; }
.wh-upload .secondary, .wh-filters .ghost { background: #e2e8f0; color: #0f172a; }
.wh-upload .danger { background: #dc2626; color: #fff; }
.wh-stats { display: grid; grid-template-columns: repeat(6, minmax(140px, 1fr)); gap: 12px; margin: 14px 0; }
.wh-stat { border-radius: 8px; padding: 14px; background: #fff; border: 1px solid #e2e8f0; box-shadow: 0 8px 24px rgba(15, 23, 42, .06); }
.wh-stat span { display: block; color: #64748b; font-size: 12px; font-weight: 800; }
.wh-stat b { display: block; margin-top: 6px; font-size: 28px; }
.wh-stat.green { border-left: 4px solid #10b981; }
.wh-stat.amber { border-left: 4px solid #f59e0b; }
.wh-stat.red { border-left: 4px solid #ef4444; }
.wh-stat.blue { border-left: 4px solid #0ea5e9; }
.wh-stat.ink { border-left: 4px solid #0f172a; }
.wh-stat.purple { border-left: 4px solid #7c3aed; }
.wh-panel { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; box-shadow: 0 8px 24px rgba(15, 23, 42, .06); }
.wh-filters { display: grid; grid-template-columns: 1.4fr repeat(7, minmax(120px, 1fr)) auto; gap: 8px; }
.wh-version-tools { display: flex; align-items: end; gap: 10px; flex-wrap: wrap; margin-top: 10px; padding: 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; }
.wh-version-tools label { display: grid; gap: 4px; color: #475569; font-size: 11px; font-weight: 850; text-transform: uppercase; letter-spacing: .04em; }
.wh-version-tools input { width: 150px; border: 1px solid #cbd5e1; background: #fff; border-radius: 6px; height: 36px; padding: 0 10px; font-size: 13px; }
.wh-version-tools button { border: 0; background: #7c3aed; color: #fff; border-radius: 6px; height: 36px; padding: 0 14px; font-weight: 850; font-size: 12px; }
.wh-version-tools button.active { background: #0f172a; }
.wh-version-tools span { color: #64748b; font-size: 12px; font-weight: 800; }
.wh-sendbar { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; padding: 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; }
.wh-sendbar span { display: block; color: #64748b; font-size: 12px; }
.wh-sendbar > button + button { margin-left: 8px; }
.wh-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin: 14px 0; }
.wh-group { height: auto; text-align: left; padding: 12px; background: #10233f; }
.wh-group span { display: block; font-weight: 900; }
.wh-group small { display: block; color: #bfdbfe; margin-top: 4px; }
.wh-pagination { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 12px 0; padding: 10px 12px; background: #fff; border: 1px solid #dbe3ec; border-radius: 8px; box-shadow: 0 8px 24px rgba(15, 23, 42, .06); }
.wh-pagination span { color: #475569; font-size: 12px; font-weight: 800; }
.wh-pagination div { display: flex; align-items: center; gap: 8px; }
.wh-pagination b { color: #0f172a; font-size: 12px; white-space: nowrap; }
.wh-table-wrap { overflow: auto; max-height: 62vh; background: #fff; border: 1px solid #dbe3ec; border-radius: 8px; box-shadow: 0 14px 34px rgba(15, 23, 42, .08); }
.wh-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; min-width: 1480px; }
.wh-table th { position: sticky; top: 0; z-index: 1; background: #f8fafc; color: #0f172a; padding: 10px; border-bottom: 1px solid #dbe3ec; text-align: left; white-space: nowrap; }
.wh-table td { padding: 10px; border-bottom: 1px solid #eef2f7; vertical-align: top; }
.wh-table tr.selected td { background: #eff6ff; }
.wh-table b { display: block; }
.wh-table small { display: block; color: #64748b; margin-top: 3px; max-width: 230px; }
.wh-pill { display: inline-flex; align-items: center; border-radius: 999px; min-height: 22px; padding: 0 9px; background: #e2e8f0; color: #334155; font-weight: 850; font-size: 11px; white-space: nowrap; }
.wh-pill-active, .wh-pill-yes, .wh-pill-available, .wh-pill-healthy, .wh-pill-0 { background: #d1fae5; color: #047857; }
.wh-pill-unavailable, .wh-pill-app-offline { background: #fee2e2; color: #b91c1c; }
.wh-pill-sync-delayed { background: #fef08a; color: #92400e; border: 1px solid #f59e0b; box-shadow: 0 0 0 3px rgba(245, 158, 11, .18); }
.wh-condition { min-width: 230px; }
.wh-condition .warning { color: #92400e; font-weight: 800; }
.wh-check { width: 42px; min-width: 42px; text-align: center; }
.wh-check input { width: 16px; height: 16px; cursor: pointer; }
.wh-footnote { margin-top: 10px; color: #64748b; font-size: 12px; }
body.dark-theme .wallet-health { color: #e5e7eb; }
body.dark-theme .wh-header,
body.dark-theme .wh-stat,
body.dark-theme .wh-panel,
body.dark-theme .wh-version-tools,
body.dark-theme .wh-sendbar,
body.dark-theme .wh-pagination,
body.dark-theme .wh-table-wrap { background: #111827; color: #e5e7eb; border-color: #263244; box-shadow: 0 14px 34px rgba(0, 0, 0, .24); }
body.dark-theme .wh-header { background: linear-gradient(180deg, #111827, #0b1220); }
body.dark-theme .wh-header h2,
body.dark-theme .wh-stat b,
body.dark-theme .wh-pagination b,
body.dark-theme .wh-table b { color: #f8fafc; }
body.dark-theme .wh-header p,
body.dark-theme .wh-stat span,
body.dark-theme .wh-sendbar span,
body.dark-theme .wh-version-tools span,
body.dark-theme .wh-version-tools label,
body.dark-theme .wh-pagination span,
body.dark-theme .wh-table small,
body.dark-theme .wh-footnote { color: #94a3b8; }
body.dark-theme .wh-upload input,
body.dark-theme .wh-filters input,
body.dark-theme .wh-version-tools input,
body.dark-theme .wh-filters select { background: #0b1220; color: #e5e7eb; border-color: #334155; }
body.dark-theme .wh-upload .secondary,
body.dark-theme .wh-filters .ghost,
body.dark-theme .wh-sendbar button.secondary,
body.dark-theme .wh-pagination button.secondary { background: #263244; color: #e5e7eb; }
body.dark-theme .wh-table th { background: #172033; color: #e5e7eb; border-color: #263244; }
body.dark-theme .wh-table td { border-color: #263244; color: #e5e7eb; }
body.dark-theme .wh-table tr.selected td { background: #0f1f3b; }
body.dark-theme .wh-pill { background: #263244; color: #dbeafe; }
button:disabled { opacity: .55; cursor: not-allowed; }
@media (max-width: 1100px) {
  .wh-header, .wh-sendbar, .wh-pagination { flex-direction: column; align-items: stretch; }
  .wh-pagination div { justify-content: space-between; flex-wrap: wrap; }
  .wh-upload, .wh-filters, .wh-stats { grid-template-columns: 1fr; }
}
`;

const walletHealthRoot = document.getElementById("walletHealthRoot");

if (walletHealthRoot) {
  ReactDOM.createRoot(walletHealthRoot).render(<WalletHealthApp />);
}
