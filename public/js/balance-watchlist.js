(function () {
    const allowedOperators = new Set(["any", "gt", "gte", "lt", "lte", "eq"]);
    const allowedAccess = new Set(["any", "open", "closed"]);
    const allowedStates = new Set(["", "FULL", "DEPOSIT_ONLY", "WITHDRAW_ONLY", "UNAVAILABLE", "INACTIVE"]);
    const allowedPresenceModes = new Set(["any", "has", "none"]);
    let sharedWatchlistLoaded = false;
    let sharedWatchlistLoadPromise = null;
    let sharedWatchlistCanEdit = null;
    let editorBaselineValues = new Map();

    function getTemplateConfig(template = "custom") {
        const base = {
            id: "",
            template,
            name: "Custom Watchlist",
            metric: "balance",
            thresholdMode: "fixed",
            operator: "any",
            amount: 0,
            state: "",
            states: [],
            depositAccess: "any",
            withdrawalAccess: "any",
            accountType: "",
            walletType: "",
            condition: "",
            recommendation: "",
            action: "",
            dpMin: null,
            dpMax: null,
            wdMin: null,
            wdMax: null,
            ownerQuery: "",
            ownerExcludeQuery: "",
            apiBalanceMin: null,
            apiBalanceMax: null,
            balanceMin: null,
            balanceMax: null,
            remarksQuery: "",
            remarksPrefixQuery: "",
            remarksExcludeQuery: "",
            presenceColumn: "",
            presenceMode: "any",
            useCustomColors: false,
            headerColor: "#3b0f1c",
            nameColor: "#fecdd3",
            hideInactive: true,
            excludeBundles: false,
            sortField: "balance",
            sortOrder: "desc",
            rowLimit: 100,
            columns: [...watchlistDefaultColumns]
        };

        if (template === "high_balance_open_deposit") {
            return {
                ...base,
                name: "High Balance — Deposit Still Open",
                thresholdMode: "daily_limit",
                operator: "gt",
                depositAccess: "open",
                dpMin: 1,
                dpMax: 10
            };
        }

        if (template === "low_balance") {
            return {
                ...base,
                name: "Low Balance",
                operator: "lt",
                amount: Number(balanceCalculationSettings.lowBalanceThreshold || 1000),
                sortOrder: "asc"
            };
        }

        if (template === "can_open_deposit") {
            return {
                ...base,
                name: "Can Open Deposit",
                operator: "lt",
                amount: Number(balanceCalculationSettings.lowBalanceThreshold || 1000),
                depositAccess: "closed",
                sortOrder: "asc"
            };
        }

        if (template === "can_open_withdrawal") {
            return {
                ...base,
                name: "Can Open Withdrawal",
                operator: "gt",
                amount: Number(balanceCalculationSettings.defaultDailyLimit || 50000),
                withdrawalAccess: "closed",
                sortOrder: "desc"
            };
        }

        return base;
    }

    function optionalNumber(value) {
        if (value === "" || value === null || value === undefined) return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function normalizeHexColor(value, fallback) {
        const color = String(value || "").trim();
        return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : fallback;
    }

    function normalizeSection(section = {}) {
        const template = String(section.template || "custom");
        const base = getTemplateConfig(template);
        const allowedColumns = new Set(overviewSendColumns.map(column => column.key));
        const columns = Array.isArray(section.columns)
            ? [...new Set(section.columns.filter(key => allowedColumns.has(key)))]
            : [];
        const states = Array.isArray(section.states)
            ? [...new Set(section.states.filter(state => allowedStates.has(state) && state))]
            : (allowedStates.has(section.state) && section.state ? [section.state] : []);

        return {
            ...base,
            ...section,
            id: String(section.id || `wl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
            template,
            name: String(section.name || base.name).trim().slice(0, 80) || base.name,
            metric: watchlistNumericFields.has(section.metric) ? section.metric : base.metric,
            thresholdMode: section.thresholdMode === "daily_limit" ? "daily_limit" : "fixed",
            operator: allowedOperators.has(section.operator) ? section.operator : base.operator,
            amount: Math.max(0, Number(section.amount ?? base.amount) || 0),
            state: states.length === 1 ? states[0] : "",
            states,
            depositAccess: allowedAccess.has(section.depositAccess) ? section.depositAccess : "any",
            withdrawalAccess: allowedAccess.has(section.withdrawalAccess) ? section.withdrawalAccess : "any",
            dpMin: optionalNumber(section.dpMin),
            dpMax: optionalNumber(section.dpMax),
            wdMin: optionalNumber(section.wdMin),
            wdMax: optionalNumber(section.wdMax),
            ownerQuery: String(section.ownerQuery || "").trim().slice(0, 500),
            ownerExcludeQuery: String(section.ownerExcludeQuery || "").trim().slice(0, 500),
            apiBalanceMin: optionalNumber(section.apiBalanceMin),
            apiBalanceMax: optionalNumber(section.apiBalanceMax),
            balanceMin: optionalNumber(section.balanceMin),
            balanceMax: optionalNumber(section.balanceMax),
            remarksQuery: String(section.remarksQuery || "").trim().slice(0, 500),
            remarksPrefixQuery: String(section.remarksPrefixQuery || "").trim().slice(0, 500),
            remarksExcludeQuery: String(section.remarksExcludeQuery || "").trim().slice(0, 500),
            presenceColumn: allowedColumns.has(section.presenceColumn) && watchlistNumericFields.has(section.presenceColumn)
                ? section.presenceColumn
                : "",
            presenceMode: allowedPresenceModes.has(section.presenceMode) ? section.presenceMode : "any",
            useCustomColors: section.useCustomColors === true,
            headerColor: normalizeHexColor(section.headerColor, base.headerColor),
            nameColor: normalizeHexColor(section.nameColor, base.nameColor),
            hideInactive: section.hideInactive !== false,
            excludeBundles: section.excludeBundles === true,
            sortField: overviewSendColumns.some(column => column.key === section.sortField)
                ? section.sortField
                : base.sortField,
            sortOrder: section.sortOrder === "asc" ? "asc" : "desc",
            rowLimit: Math.min(500, Math.max(1, Math.floor(Number(section.rowLimit) || 100))),
            columns: columns.length ? columns : [...watchlistDefaultColumns]
        };
    }

    function loadSections() {
        if (watchlistSectionsLoaded) return;
        try {
            const saved = JSON.parse(localStorage.getItem(watchlistStorageKey) || "[]");
            watchlistSections = Array.isArray(saved) ? saved.map(normalizeSection) : [];
        } catch (err) {
            console.warn("Watchlist settings load failed:", err);
            watchlistSections = [];
        }
        watchlistSectionsLoaded = true;
    }

    function canEditSections() {
        if (sharedWatchlistCanEdit !== null) return sharedWatchlistCanEdit;
        const user = typeof currentUser !== "undefined" ? currentUser : null;
        return user?.role === "developer" ||
            (typeof hasPermission === "function" && hasPermission("settings_access"));
    }

    function syncEditControls() {
        const canEdit = canEditSections();
        document.querySelectorAll(".watchlist-edit-control").forEach(control => {
            control.style.display = canEdit ? "" : "none";
        });
        const emptyTitle = document.querySelector("#watchlistEmptyState h4");
        const emptyCopy = document.querySelector("#watchlistEmptyState p");
        if (!canEdit && emptyTitle) emptyTitle.textContent = "No shared watchlist sections";
        if (!canEdit && emptyCopy) emptyCopy.textContent = "A developer can add shared sections for everyone with Balance access.";
    }

    async function persistSections() {
        localStorage.setItem(watchlistStorageKey, JSON.stringify(watchlistSections));
        if (!canEditSections()) throw new Error("You do not have permission to edit the shared watchlist");

        const response = await fetch("/api/balance/watchlist-settings", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sections: watchlistSections })
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.message || "Shared watchlist save failed");
        }
        watchlistSections = Array.isArray(data.sections)
            ? data.sections.map(normalizeSection)
            : watchlistSections;
        localStorage.setItem(watchlistStorageKey, JSON.stringify(watchlistSections));
        return true;
    }

    async function loadSharedSections() {
        if (sharedWatchlistLoaded) return;
        if (sharedWatchlistLoadPromise) return sharedWatchlistLoadPromise;

        sharedWatchlistLoadPromise = (async () => {
            try {
                const response = await fetch("/api/balance/watchlist-settings", {
                    credentials: "include"
                });
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error("Shared watchlist load failed");
                sharedWatchlistCanEdit = data.canEdit === true;

                const serverSections = Array.isArray(data.sections)
                    ? data.sections.map(normalizeSection)
                    : [];
                const localSections = [...watchlistSections];

                if (!serverSections.length && localSections.length && canEditSections()) {
                    watchlistSections = localSections;
                    await persistSections();
                } else {
                    watchlistSections = serverSections;
                    localStorage.setItem(watchlistStorageKey, JSON.stringify(watchlistSections));
                }
                sharedWatchlistLoaded = true;
                renderBalanceWatchlistFlexible();
            } catch (err) {
                console.warn("Shared watchlist unavailable; using browser fallback:", err);
            } finally {
                sharedWatchlistLoadPromise = null;
            }
        })();

        return sharedWatchlistLoadPromise;
    }

    function isSideOpen(row, side) {
        const state = getState(row, true);
        const priority = Number(side === "deposit" ? row.depositPriority : row.withdrawalPriority) || 0;
        const priorityEnabled = priority >= 1 && priority <= 10;
        const stateEnabled = side === "deposit"
            ? state === "FULL" || state === "DEPOSIT_ONLY"
            : state === "FULL" || state === "WITHDRAW_ONLY";

        return priorityEnabled && stateEnabled;
    }

    function compareAmount(value, operator, threshold) {
        if (operator === "any") return true;
        if (operator === "gt") return value > threshold;
        if (operator === "gte") return value >= threshold;
        if (operator === "lt") return value < threshold;
        if (operator === "lte") return value <= threshold;
        return Math.abs(value - threshold) < 0.005;
    }

    function matchesText(value, query) {
        const needle = String(query || "").trim().toUpperCase();
        return !needle || String(value || "").toUpperCase().includes(needle);
    }

    function getFilterTerms(value) {
        return [...new Set(String(value || "")
            .split(/[,;\n]+/)
            .map(term => term.trim().toUpperCase())
            .filter(Boolean))];
    }

    function matchesAnyTerm(value, terms) {
        const haystack = String(value || "").toUpperCase();
        return terms.some(term => haystack.includes(term));
    }

    function matchesAnyPrefix(value, terms) {
        const haystack = String(value || "").trim().toUpperCase();
        return terms.some(term => haystack.startsWith(term));
    }

    function hasColumnValue(row, key) {
        const value = getBalanceSortValue(row, key, true);
        if (watchlistNumericFields.has(key)) {
            const number = Number(value);
            return Number.isFinite(number) && Math.abs(number) > 0.000001;
        }
        const text = String(value ?? "").trim();
        return Boolean(text && text !== "-");
    }

    function matchesSection(row, section) {
        const state = getState(row, true);
        const selectedStates = Array.isArray(section.states)
            ? section.states
            : (section.state ? [section.state] : []);
        const decision = getWalletDecision(row);
        const metricValue = Number(getBalanceSortValue(row, section.metric, true) || 0);
        const threshold = section.thresholdMode === "daily_limit"
            ? getBalanceDailyLimit(row)
            : Number(section.amount || 0);

        if (!compareAmount(metricValue, section.operator, threshold)) return false;
        if (section.hideInactive && state === "INACTIVE" && !selectedStates.includes("INACTIVE")) return false;
        if (section.excludeBundles && isBundleAccount(row)) return false;
        if (selectedStates.length && !selectedStates.includes(state)) return false;

        const depositOpen = isSideOpen(row, "deposit");
        const withdrawalOpen = isSideOpen(row, "withdrawal");
        if (section.depositAccess === "open" && !depositOpen) return false;
        if (section.depositAccess === "closed" && depositOpen) return false;
        if (section.withdrawalAccess === "open" && !withdrawalOpen) return false;
        if (section.withdrawalAccess === "closed" && withdrawalOpen) return false;

        const dpPriority = Number(row.depositPriority || 0);
        const wdPriority = Number(row.withdrawalPriority || 0);
        if (section.dpMin !== null && dpPriority < section.dpMin) return false;
        if (section.dpMax !== null && dpPriority > section.dpMax) return false;
        if (section.wdMin !== null && wdPriority < section.wdMin) return false;
        if (section.wdMax !== null && wdPriority > section.wdMax) return false;

        const apiBalance = Number(getBalanceSortValue(row, "apiBalance", true) || 0);
        const balance = Number(getBalanceSortValue(row, "balance", true) || 0);
        if (section.apiBalanceMin !== null && apiBalance < section.apiBalanceMin) return false;
        if (section.apiBalanceMax !== null && apiBalance > section.apiBalanceMax) return false;
        if (section.balanceMin !== null && balance < section.balanceMin) return false;
        if (section.balanceMax !== null && balance > section.balanceMax) return false;

        if (section.accountType && String(row.accountType || "").toLowerCase() !== section.accountType.toLowerCase()) return false;
        if (section.walletType && normalizeWalletTypeKey(row.walletType) !== normalizeWalletTypeKey(section.walletType)) return false;
        if (section.condition && String(row.walletCondition || "").toUpperCase() !== section.condition.toUpperCase()) return false;
        if (section.recommendation && decision.recommendation !== section.recommendation) return false;
        if (section.action && decision.action !== section.action) return false;
        const ownerIncludes = getFilterTerms(section.ownerQuery);
        const ownerExcludes = getFilterTerms(section.ownerExcludeQuery);
        if (ownerIncludes.length && !matchesAnyTerm(row.ownerName, ownerIncludes)) return false;
        if (ownerExcludes.length && matchesAnyTerm(row.ownerName, ownerExcludes)) return false;
        if (!matchesText(getBundleRemarks(row), section.remarksQuery)) return false;
        const remarks = getBundleRemarks(row);
        const remarkPrefixes = getFilterTerms(section.remarksPrefixQuery);
        const remarkExcludes = getFilterTerms(section.remarksExcludeQuery);
        if (remarkPrefixes.length && !matchesAnyPrefix(remarks, remarkPrefixes)) return false;
        if (remarkExcludes.length && matchesAnyTerm(remarks, remarkExcludes)) return false;
        if (section.presenceColumn && section.presenceMode !== "any") {
            const hasValue = hasColumnValue(row, section.presenceColumn);
            if (section.presenceMode === "has" && !hasValue) return false;
            if (section.presenceMode === "none" && hasValue) return false;
        }
        return true;
    }

    function getSectionRows(section) {
        const matched = overviewBalanceData.filter(row => matchesSection(row, section));
        const direction = section.sortOrder === "asc" ? 1 : -1;
        matched.sort((a, b) => {
            const aValue = getBalanceSortValue(a, section.sortField, true);
            const bValue = getBalanceSortValue(b, section.sortField, true);
            if (watchlistNumericFields.has(section.sortField)) {
                return (Number(aValue || 0) - Number(bValue || 0)) * direction;
            }
            return String(aValue || "").localeCompare(String(bValue || ""), undefined, {
                numeric: true,
                sensitivity: "base"
            }) * direction;
        });

        return { total: matched.length, rows: matched.slice(0, section.rowLimit) };
    }

    function formatRule(section) {
        const metric = overviewSendColumns.find(column => column.key === section.metric)?.label || "Balance";
        const operators = { any: "Any", gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=" };
        const threshold = section.thresholdMode === "daily_limit"
            ? "Daily Limit / SDP"
            : formatBalanceAmount(section.amount);
        return section.operator === "any" ? "Any amount" : `${metric} ${operators[section.operator]} ${threshold}`;
    }

    function getRuleChips(section) {
        const chips = [formatRule(section)];
        const stateLabels = {
            FULL: "Active — Available",
            DEPOSIT_ONLY: "Active — Deposit Only",
            WITHDRAW_ONLY: "Active — Withdrawal Only",
            UNAVAILABLE: "Active — Unavailable",
            INACTIVE: "Inactive"
        };
        if (section.depositAccess !== "any") chips.push(`Deposit ${section.depositAccess}`);
        if (section.withdrawalAccess !== "any") chips.push(`Withdrawal ${section.withdrawalAccess}`);
        const selectedStates = Array.isArray(section.states)
            ? section.states
            : (section.state ? [section.state] : []);
        if (selectedStates.length) chips.push(selectedStates.map(state => stateLabels[state] || state).join(", "));
        if (section.walletType) chips.push(section.walletType);
        if (section.condition) chips.push(section.condition);
        if (section.ownerQuery) chips.push(`Owner: ${section.ownerQuery}`);
        if (section.ownerExcludeQuery) chips.push(`Exclude: ${section.ownerExcludeQuery}`);
        if (section.balanceMin !== null || section.balanceMax !== null) {
            chips.push(`Balance ${section.balanceMin ?? "−∞"} – ${section.balanceMax ?? "∞"}`);
        }
        if (section.apiBalanceMin !== null || section.apiBalanceMax !== null) {
            chips.push(`API ${section.apiBalanceMin ?? "−∞"} – ${section.apiBalanceMax ?? "∞"}`);
        }
        if (section.remarksPrefixQuery) chips.push(`Remarks: ${section.remarksPrefixQuery}`);
        if (section.remarksExcludeQuery) chips.push(`No remarks: ${section.remarksExcludeQuery}`);
        if (section.presenceColumn && section.presenceMode !== "any") {
            const label = overviewSendColumns.find(column => column.key === section.presenceColumn)?.label || section.presenceColumn;
            chips.push(`${section.presenceMode === "has" ? "Has" : "No"} ${label}`);
        }
        return chips.slice(0, 5);
    }

    function getCellValue(row, key) {
        if (key === "status") return getOverviewStatusLabel(row, true);
        return getOverviewSendValue(row, key, true);
    }

    function getCellClass(key, row) {
        if (key === "balance") return `watchlist-balance ${getDirectionalAmountClass("balance", getBalanceRowAmount(row))}`;
        if (key === "todayDeposits") return getDirectionalAmountClass("deposit", row.todayDeposits);
        if (key === "todayWithdrawals") return getDirectionalAmountClass("withdrawal", row.todayWithdrawals);
        if (key === "settlement") return getDirectionalAmountClass("settlement", getSettlementAmount(row));
        if (key === "apiBalance") return getDirectionalAmountClass("api", row.apiBalance);
        return "";
    }

    function renderSection(section, index) {
        const editable = canEditSections();
        const result = getSectionRows(section);
        const columns = section.columns
            .map(key => overviewSendColumns.find(column => column.key === key))
            .filter(Boolean);
        const header = columns.map(column => `<th>${escapeHtml(column.label)}</th>`).join("");
        const rows = result.rows.length
            ? result.rows.map(row => `
                <tr>${columns.map(column => `
                    <td class="${getCellClass(column.key, row)}">${escapeHtml(getCellValue(row, column.key))}</td>
                `).join("")}</tr>
            `).join("")
            : `<tr><td colspan="${columns.length}" class="balance-watchlist-empty">No accounts match this saved section.</td></tr>`;
        const headerStyle = section.useCustomColors
            ? ` style="background:${escapeHtmlAttribute(section.headerColor)}"`
            : "";
        const nameStyle = section.useCustomColors
            ? ` style="color:${escapeHtmlAttribute(section.nameColor)};border-color:${escapeHtmlAttribute(section.nameColor)}"`
            : "";
        const nameControl = editable
            ? `<input class="watchlist-section-name-input"
                    aria-label="Section name"
                    title="Edit section name"
                    size="${Math.min(42, Math.max(12, section.name.length))}"
                    ${nameStyle}
                    value="${escapeHtmlAttribute(section.name)}"
                    onchange="renameWatchlistSection('${escapeHtmlAttribute(section.id)}', this.value)"
                    onkeydown="if(event.key === 'Enter') this.blur()">`
            : `<h4 class="balance-watchlist-title"${nameStyle}>${escapeHtml(section.name)}</h4>`;
        const editActions = editable ? `
            <button class="btn btn-outline-secondary" title="Move left" aria-label="Move section left" ${index === 0 ? "disabled" : ""} onclick="moveWatchlistSection('${escapeHtmlAttribute(section.id)}', -1)"><i class="bi bi-arrow-left"></i></button>
            <button class="btn btn-outline-secondary" title="Move right" aria-label="Move section right" ${index === watchlistSections.length - 1 ? "disabled" : ""} onclick="moveWatchlistSection('${escapeHtmlAttribute(section.id)}', 1)"><i class="bi bi-arrow-right"></i></button>
            <button class="btn btn-outline-primary" onclick="openWatchlistSectionEditor('${escapeHtmlAttribute(section.id)}')"><i class="bi bi-sliders"></i> Settings</button>
            <button class="btn btn-outline-info" onclick="duplicateWatchlistSection('${escapeHtmlAttribute(section.id)}')"><i class="bi bi-copy"></i></button>
            <button class="btn btn-outline-danger" onclick="deleteWatchlistSection('${escapeHtmlAttribute(section.id)}')"><i class="bi bi-trash"></i></button>
        ` : "";

        return `
            <section class="balance-watchlist-section" data-watchlist-id="${escapeHtmlAttribute(section.id)}">
                <div class="balance-watchlist-header"${headerStyle}>
                    <div class="balance-watchlist-heading">
                        <span class="balance-watchlist-icon"><i class="bi bi-filter-circle-fill"></i></span>
                        <div>
                            ${nameControl}
                        </div>
                    </div>
                    <div class="watchlist-section-actions">
                        <span class="balance-watchlist-count" title="${result.rows.length} shown">${result.total.toLocaleString()}</span>
                        ${editActions}
                    </div>
                </div>
                <div class="table-responsive watchlist-table-scroll">
                    <table class="table premium-table balance-watchlist-table">
                        <thead><tr>${header}</tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </section>
        `;
    }

    function renderBalanceWatchlistFlexible() {
        loadSections();
        loadSharedSections();
        syncEditControls();
        const grid = document.getElementById("watchlistSectionsGrid");
        const empty = document.getElementById("watchlistEmptyState");
        if (!grid || !empty) return;

        empty.style.display = watchlistSections.length ? "none" : "grid";
        grid.style.display = watchlistSections.length ? "flex" : "none";
        grid.innerHTML = watchlistSections.map(renderSection).join("");
        requestAnimationFrame(updateWatchlistScrollButtons);
    }

    function updateWatchlistScrollButtons() {
        const grid = document.getElementById("watchlistSectionsGrid");
        const left = document.getElementById("watchlistScrollLeft");
        const right = document.getElementById("watchlistScrollRight");
        if (!grid || !left || !right) return;
        const maxScroll = Math.max(0, grid.scrollWidth - grid.clientWidth);
        left.disabled = grid.scrollLeft <= 1;
        right.disabled = grid.scrollLeft >= maxScroll - 1;
    }

    function syncWatchlistHorizontalScroll() {
        updateWatchlistScrollButtons();
    }

    function scrollSections(direction) {
        const grid = document.getElementById("watchlistSectionsGrid");
        if (!grid) return;
        const firstCard = grid.querySelector(".balance-watchlist-section");
        const distance = firstCard ? firstCard.offsetWidth + 12 : grid.clientWidth * 0.85;
        const maxScroll = Math.max(0, grid.scrollWidth - grid.clientWidth);
        const next = Math.min(maxScroll, Math.max(0, grid.scrollLeft + Number(direction || 0) * distance));
        grid.scrollTo({ left: next, behavior: "smooth" });
    }

    function setSelectOptions(id, columns, blankLabel = "") {
        const select = document.getElementById(id);
        if (!select) return;
        select.innerHTML = blankLabel ? `<option value="">${escapeHtml(blankLabel)}</option>` : "";
        columns.forEach(column => {
            select.insertAdjacentHTML("beforeend", `<option value="${escapeHtmlAttribute(column.key)}">${escapeHtml(column.label)}</option>`);
        });
    }

    function initializeEditorControls() {
        setSelectOptions("wlMetric", overviewSendColumns.filter(column => watchlistNumericFields.has(column.key)));
        setSelectOptions("wlSortField", overviewSendColumns);
        setSelectOptions("wlPresenceColumn", overviewSendColumns.filter(column => watchlistNumericFields.has(column.key)), "Choose a column");

        const walletType = document.getElementById("wlWalletType");
        if (walletType) {
            const types = [...new Set([
                ...walletTypeSettings,
                ...overviewBalanceData.map(row => getWalletTypeDisplay(row.walletType)).filter(Boolean)
            ])].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
            walletType.innerHTML = '<option value="">Any wallet</option>' + types
                .map(type => `<option value="${escapeHtmlAttribute(type)}">${escapeHtml(type)}</option>`)
                .join("");
        }

        const choices = document.getElementById("wlColumnChoices");
        if (choices) {
            choices.innerHTML = overviewSendColumns.map(column => `
                <label><input type="checkbox" value="${escapeHtmlAttribute(column.key)}"> ${escapeHtml(column.label)}</label>
            `).join("");
        }
    }

    function setEditorValues(section) {
        initializeEditorControls();
        const values = {
            wlTemplate: section.template,
            wlName: section.name,
            wlMetric: section.metric,
            wlThresholdMode: section.thresholdMode,
            wlOperator: section.operator,
            wlAmount: section.amount,
            wlDepositAccess: section.depositAccess,
            wlWithdrawalAccess: section.withdrawalAccess,
            wlAccountType: section.accountType,
            wlWalletType: section.walletType,
            wlCondition: section.condition,
            wlRecommendation: section.recommendation,
            wlAction: section.action,
            wlDpMin: section.dpMin ?? "",
            wlDpMax: section.dpMax ?? "",
            wlWdMin: section.wdMin ?? "",
            wlWdMax: section.wdMax ?? "",
            wlOwnerQuery: section.ownerQuery,
            wlOwnerExcludeQuery: section.ownerExcludeQuery,
            wlApiBalanceMin: section.apiBalanceMin ?? "",
            wlApiBalanceMax: section.apiBalanceMax ?? "",
            wlBalanceMin: section.balanceMin ?? "",
            wlBalanceMax: section.balanceMax ?? "",
            wlRemarksPrefixQuery: section.remarksPrefixQuery || section.remarksQuery,
            wlRemarksExcludeQuery: section.remarksExcludeQuery,
            wlPresenceColumn: section.presenceColumn,
            wlPresenceMode: section.presenceMode,
            wlHeaderColor: section.headerColor,
            wlNameColor: section.nameColor,
            wlSortField: section.sortField,
            wlSortOrder: section.sortOrder,
            wlRowLimit: section.rowLimit
        };
        Object.entries(values).forEach(([id, value]) => {
            const element = document.getElementById(id);
            if (element) element.value = value;
        });
        document.getElementById("wlHideInactive").checked = section.hideInactive;
        document.getElementById("wlExcludeBundles").checked = section.excludeBundles;
        document.getElementById("wlUseCustomColors").checked = section.useCustomColors;
        const selectedStates = Array.isArray(section.states)
            ? section.states
            : (section.state ? [section.state] : []);
        document.querySelectorAll("#wlStateChoices input").forEach(input => {
            input.checked = selectedStates.includes(input.value);
        });
        document.querySelectorAll("#wlColumnChoices input").forEach(input => {
            input.checked = section.columns.includes(input.value);
        });
        syncWatchlistThresholdInputFlexible();
        syncWatchlistColorInputsFlexible();
    }

    function readEditorSection() {
        const value = id => document.getElementById(id)?.value || "";
        return normalizeSection({
            id: editingWatchlistSectionId || "",
            template: value("wlTemplate"),
            name: value("wlName"),
            metric: value("wlMetric"),
            thresholdMode: value("wlThresholdMode"),
            operator: value("wlOperator"),
            amount: value("wlAmount"),
            states: [...document.querySelectorAll("#wlStateChoices input:checked")].map(input => input.value),
            depositAccess: value("wlDepositAccess"),
            withdrawalAccess: value("wlWithdrawalAccess"),
            accountType: value("wlAccountType"),
            walletType: value("wlWalletType"),
            condition: value("wlCondition"),
            recommendation: value("wlRecommendation"),
            action: value("wlAction"),
            dpMin: value("wlDpMin"),
            dpMax: value("wlDpMax"),
            wdMin: value("wlWdMin"),
            wdMax: value("wlWdMax"),
            ownerQuery: value("wlOwnerQuery"),
            ownerExcludeQuery: value("wlOwnerExcludeQuery"),
            apiBalanceMin: value("wlApiBalanceMin"),
            apiBalanceMax: value("wlApiBalanceMax"),
            balanceMin: value("wlBalanceMin"),
            balanceMax: value("wlBalanceMax"),
            remarksQuery: "",
            remarksPrefixQuery: value("wlRemarksPrefixQuery"),
            remarksExcludeQuery: value("wlRemarksExcludeQuery"),
            presenceColumn: value("wlPresenceColumn"),
            presenceMode: value("wlPresenceMode"),
            useCustomColors: document.getElementById("wlUseCustomColors")?.checked === true,
            headerColor: value("wlHeaderColor"),
            nameColor: value("wlNameColor"),
            hideInactive: document.getElementById("wlHideInactive")?.checked !== false,
            excludeBundles: document.getElementById("wlExcludeBundles")?.checked === true,
            sortField: value("wlSortField"),
            sortOrder: value("wlSortOrder"),
            rowLimit: value("wlRowLimit"),
            columns: [...document.querySelectorAll("#wlColumnChoices input:checked")].map(input => input.value)
        });
    }

    function getEditorControls() {
        const modal = document.getElementById("watchlistConfigModal");
        return modal ? [...modal.querySelectorAll("input, select")] : [];
    }

    function getEditorControlKey(control) {
        if (control.id) return control.id;
        const groupId = control.closest("[id]")?.id || "watchlist-editor";
        return `${groupId}:${control.type || control.tagName}:${control.value}`;
    }

    function getEditorControlValue(control) {
        if (control.type === "checkbox" || control.type === "radio") {
            return control.checked ? "checked" : "unchecked";
        }
        return String(control.value ?? "");
    }

    function captureEditorBaseline() {
        editorBaselineValues = new Map(getEditorControls().map(control => [
            getEditorControlKey(control),
            getEditorControlValue(control)
        ]));
        updateEditorChangeIndicators();
    }

    function updateEditorChangeIndicators() {
        const modal = document.getElementById("watchlistConfigModal");
        if (!modal || !editorBaselineValues.size) return;
        let hasChanges = false;

        getEditorControls().forEach(control => {
            const changed = editorBaselineValues.get(getEditorControlKey(control)) !== getEditorControlValue(control);
            const marker = control.type === "checkbox" || control.type === "radio"
                ? control.closest("label") || control
                : control;
            marker.classList.toggle("watchlist-field-changed", changed);
            hasChanges = hasChanges || changed;
        });

        modal.querySelectorAll(".watchlist-config-group").forEach(group => {
            group.classList.toggle("watchlist-config-group-changed", Boolean(group.querySelector(".watchlist-field-changed")));
        });
        const indicator = document.getElementById("watchlistUnsavedIndicator");
        if (indicator) indicator.hidden = !hasChanges;
    }

    function openEditor(id = "") {
        if (!canEditSections()) {
            showToast("You can view this shared watchlist, but you cannot edit it", "warning");
            return;
        }
        loadSections();
        editingWatchlistSectionId = id;
        const existing = watchlistSections.find(section => section.id === id);
        setEditorValues(existing ? normalizeSection(existing) : getTemplateConfig("custom"));
        document.getElementById("watchlistConfigTitle").textContent = existing
            ? "Edit Watchlist Section"
            : "Add Watchlist Section";
        const modal = document.getElementById("watchlistConfigModal");
        modal.style.display = "grid";
        modal.setAttribute("aria-hidden", "false");
        document.body.classList.add("watchlist-modal-open");
        captureEditorBaseline();
    }

    function closeEditor() {
        const modal = document.getElementById("watchlistConfigModal");
        if (!modal) return;
        modal.style.display = "none";
        modal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("watchlist-modal-open");
        editingWatchlistSectionId = null;
        editorBaselineValues = new Map();
    }

    function applyTemplate(template) {
        const currentId = editingWatchlistSectionId;
        const config = getTemplateConfig(template);
        config.id = currentId || "";
        setEditorValues(config);
    }

    function syncWatchlistThresholdInputFlexible() {
        const amount = document.getElementById("wlAmount");
        const mode = document.getElementById("wlThresholdMode")?.value;
        const operator = document.getElementById("wlOperator")?.value;
        if (amount) amount.disabled = mode === "daily_limit" || operator === "any";
    }

    function syncWatchlistColorInputsFlexible() {
        const enabled = document.getElementById("wlUseCustomColors")?.checked === true;
        ["wlHeaderColor", "wlNameColor"].forEach(id => {
            const input = document.getElementById(id);
            if (input) input.disabled = !enabled;
        });
    }

    async function saveSection() {
        if (!canEditSections()) return;
        const section = readEditorSection();
        if (!String(section.name || "").trim()) {
            showToast("Section name is required", "warning");
            return;
        }
        if (!section.columns.length) {
            showToast("Choose at least one column", "warning");
            return;
        }
        if (section.presenceMode !== "any" && !section.presenceColumn) {
            showToast("Choose a column for the Has/No value check", "warning");
            return;
        }
        const invalidRange = [
            [section.apiBalanceMin, section.apiBalanceMax, "API Balance"],
            [section.balanceMin, section.balanceMax, "Balance"]
        ].find(([minimum, maximum]) => minimum !== null && maximum !== null && minimum > maximum);
        if (invalidRange) {
            showToast(`${invalidRange[2]} minimum cannot be greater than maximum`, "warning");
            return;
        }

        const previous = [...watchlistSections];
        const index = watchlistSections.findIndex(item => item.id === editingWatchlistSectionId);
        if (index >= 0) watchlistSections[index] = section;
        else watchlistSections.push(section);
        try {
            await persistSections();
            closeEditor();
            renderBalanceWatchlistFlexible();
            showToast("Shared watchlist section saved", "success");
        } catch (err) {
            watchlistSections = previous;
            showToast(err.message || "Shared watchlist save failed", "error");
        }
    }

    async function deleteSection(id) {
        if (!canEditSections()) return;
        const section = watchlistSections.find(item => item.id === id);
        if (!section || !confirm(`Delete watchlist section "${section.name}"?`)) return;
        const previous = [...watchlistSections];
        watchlistSections = watchlistSections.filter(item => item.id !== id);
        renderBalanceWatchlistFlexible();
        try {
            await persistSections();
            showToast("Shared watchlist section deleted", "success");
        } catch (err) {
            watchlistSections = previous;
            renderBalanceWatchlistFlexible();
            showToast(err.message || "Shared watchlist save failed", "error");
        }
    }

    async function duplicateSection(id) {
        if (!canEditSections()) return;
        const section = watchlistSections.find(item => item.id === id);
        if (!section) return;
        const previous = [...watchlistSections];
        watchlistSections.push(normalizeSection({
            ...section,
            id: "",
            name: `${section.name} Copy`
        }));
        renderBalanceWatchlistFlexible();
        try {
            await persistSections();
        } catch (err) {
            watchlistSections = previous;
            renderBalanceWatchlistFlexible();
            showToast(err.message || "Shared watchlist save failed", "error");
        }
    }

    async function moveSection(id, delta) {
        if (!canEditSections()) return;
        const index = watchlistSections.findIndex(item => item.id === id);
        const target = index + Number(delta || 0);
        if (index < 0 || target < 0 || target >= watchlistSections.length) return;
        const previous = [...watchlistSections];
        [watchlistSections[index], watchlistSections[target]] = [watchlistSections[target], watchlistSections[index]];
        renderBalanceWatchlistFlexible();
        try {
            await persistSections();
        } catch (err) {
            watchlistSections = previous;
            renderBalanceWatchlistFlexible();
            showToast(err.message || "Shared watchlist save failed", "error");
        }
    }

    async function renameSection(id, name) {
        if (!canEditSections()) return;
        const section = watchlistSections.find(item => item.id === id);
        if (!section) return;
        const nextName = String(name || "").trim().slice(0, 80);
        if (!nextName) {
            renderBalanceWatchlistFlexible();
            showToast("Section name cannot be empty", "warning");
            return;
        }
        const previousName = section.name;
        section.name = nextName;
        try {
            await persistSections();
        } catch (err) {
            section.name = previousName;
            renderBalanceWatchlistFlexible();
            showToast(err.message || "Shared watchlist save failed", "error");
        }
    }

    window.renderBalanceWatchlist = renderBalanceWatchlistFlexible;
    window.openWatchlistSectionEditor = openEditor;
    window.closeWatchlistSectionEditor = closeEditor;
    window.applyWatchlistTemplateToEditor = applyTemplate;
    window.syncWatchlistThresholdInput = syncWatchlistThresholdInputFlexible;
    window.syncWatchlistColorInputs = syncWatchlistColorInputsFlexible;
    window.saveWatchlistSection = saveSection;
    window.deleteWatchlistSection = deleteSection;
    window.duplicateWatchlistSection = duplicateSection;
    window.moveWatchlistSection = moveSection;
    window.renameWatchlistSection = renameSection;
    window.scrollWatchlistSections = scrollSections;
    window.getWatchlistTemplateConfig = getTemplateConfig;
    window.getWatchlistSectionRows = getSectionRows;

    document.addEventListener("click", event => {
        if (event.target?.id === "watchlistConfigModal") closeEditor();
    });
    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && document.getElementById("watchlistConfigModal")?.style.display !== "none") {
            closeEditor();
        }
    });
    document.getElementById("watchlistSectionsGrid")?.addEventListener("scroll", () => {
        syncWatchlistHorizontalScroll();
    });
    document.getElementById("watchlistConfigModal")?.addEventListener("input", updateEditorChangeIndicators);
    document.getElementById("watchlistConfigModal")?.addEventListener("change", () => {
        requestAnimationFrame(updateEditorChangeIndicators);
    });
    window.addEventListener("resize", updateWatchlistScrollButtons);
})();
