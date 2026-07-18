const operationsMetricDefinitions = {
    balance: { label: "Selected Balance" },
    opening: { label: "Opening" },
    dpLimit: { label: "DP Limit" },
    remaining: { label: "Remaining" },
    todayDp: { label: "Today DP" },
    todayWd: { label: "Today WD" },
    settlement: { label: "Settlement" },
    apiBalance: { label: "API Balance" }
};

let operationsLastResult = null;

function getOperationsSelectionData() {
    const data = window.essCalculatorSelectionMetrics;
    return data && typeof data === "object"
        ? data
        : { count: 0, totals: {}, values: [] };
}

function formatOperationsNumber(value, maximumFractionDigits = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "Unavailable";

    return number.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits
    });
}

function setOperationsText(id, value) {
    const element = document.getElementById(id);
    if (element) element.innerText = value;
}

function renderOperationsSummary(data = getOperationsSelectionData()) {
    setOperationsText("opsSelectedCount", String(Number(data.count || 0)));
    setOperationsText("selectedRowsTotal", formatOperationsNumber(data.totals?.balance || 0));
    setOperationsText("opsOpeningTotal", formatOperationsNumber(data.totals?.opening || 0));
    setOperationsText("opsDpLimitTotal", formatOperationsNumber(data.totals?.dpLimit || 0));
}

function renderOperationsAnalysis(data = getOperationsSelectionData()) {
    const metricSelect = document.getElementById("opsAnalysisMetric");
    const metric = metricSelect?.value || "balance";
    const values = Array.isArray(data.values)
        ? data.values.map(row => Number(row?.[metric] || 0)).filter(Number.isFinite)
        : [];

    const total = values.reduce((sum, value) => sum + value, 0);
    const average = values.length ? total / values.length : 0;
    const minimum = values.length ? Math.min(...values) : 0;
    const maximum = values.length ? Math.max(...values) : 0;
    const nonZero = values.filter(value => value !== 0).length;
    const negative = values.filter(value => value < 0).length;

    setOperationsText("opsStatTotal", formatOperationsNumber(total));
    setOperationsText("opsStatAverage", formatOperationsNumber(average));
    setOperationsText("opsStatMinimum", formatOperationsNumber(minimum));
    setOperationsText("opsStatMaximum", formatOperationsNumber(maximum));
    setOperationsText("opsAnalysisMeta", `${nonZero} non-zero · ${negative} negative`);
}

function syncOperationsCustomAmountField() {
    const rightMetric = document.getElementById("opsCompareRight")?.value || "custom";
    document.getElementById("opsCustomAmountField")?.classList.toggle("is-hidden", rightMetric !== "custom");
}

function resetOperationsComparison(message = "Choose values and a function.") {
    operationsLastResult = null;
    setOperationsText("opsCompareValue", "0.00");
    setOperationsText("opsCompareDetail", message);

    const useButton = document.getElementById("opsUseResult");
    if (useButton) useButton.disabled = true;
}

function calculateOperationsComparison(options = {}) {
    const data = getOperationsSelectionData();
    const leftMetric = document.getElementById("opsCompareLeft")?.value || "balance";
    const rightMetric = document.getElementById("opsCompareRight")?.value || "custom";
    const operation = document.getElementById("opsCompareFunction")?.value || "difference";
    const customInput = document.getElementById("opsCustomAmount");

    const leftValue = Number(data.totals?.[leftMetric] || 0);
    let rightValue;
    let rightLabel;

    if (rightMetric === "custom") {
        if (!String(customInput?.value || "").trim()) {
            if (!options.silent) resetOperationsComparison("Enter a custom amount to compare.");
            return;
        }
        rightValue = Number(customInput.value);
        rightLabel = "Custom Amount";
    } else {
        rightValue = Number(data.totals?.[rightMetric] || 0);
        rightLabel = operationsMetricDefinitions[rightMetric]?.label || rightMetric;
    }

    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
        resetOperationsComparison("One of the comparison values is invalid.");
        return;
    }

    let result;
    let resultSuffix = "";
    let operationLabel = "Difference";

    if (operation === "difference") result = leftValue - rightValue;
    if (operation === "sum") {
        result = leftValue + rightValue;
        operationLabel = "Sum";
    }
    if (operation === "percent") {
        result = rightValue === 0 ? NaN : (leftValue / rightValue) * 100;
        resultSuffix = "%";
        operationLabel = "Percentage";
    }
    if (operation === "variance") {
        result = rightValue === 0 ? NaN : ((leftValue - rightValue) / Math.abs(rightValue)) * 100;
        resultSuffix = "%";
        operationLabel = "Variance";
    }
    if (operation === "ratio") {
        result = rightValue === 0 ? NaN : leftValue / rightValue;
        resultSuffix = "x";
        operationLabel = "Ratio";
    }
    if (operation === "minimum") {
        result = Math.min(leftValue, rightValue);
        operationLabel = "Smaller value";
    }
    if (operation === "maximum") {
        result = Math.max(leftValue, rightValue);
        operationLabel = "Larger value";
    }

    if (!Number.isFinite(result)) {
        resetOperationsComparison("This function cannot divide by zero.");
        return;
    }

    const leftLabel = operationsMetricDefinitions[leftMetric]?.label || leftMetric;
    const difference = leftValue - rightValue;
    const relation = Math.abs(difference) < 0.005
        ? "equal to"
        : difference > 0 ? "above" : "below";
    const formattedResult = `${formatOperationsNumber(result, 4)}${resultSuffix}`;

    setOperationsText("opsCompareValue", formattedResult);
    setOperationsText(
        "opsCompareDetail",
        `${leftLabel}: ${formatOperationsNumber(leftValue)} · ${rightLabel}: ${formatOperationsNumber(rightValue)} · A is ${formatOperationsNumber(Math.abs(difference))} ${relation} B.`
    );

    operationsLastResult = {
        value: result,
        expression: `${operationLabel}: ${leftLabel} and ${rightLabel}`
    };

    const useButton = document.getElementById("opsUseResult");
    if (useButton) useButton.disabled = false;
}

function renderOperations(data = getOperationsSelectionData()) {
    renderOperationsSummary(data);
    renderOperationsAnalysis(data);

    const rightMetric = document.getElementById("opsCompareRight")?.value || "custom";
    const hasCustomValue = Boolean(String(document.getElementById("opsCustomAmount")?.value || "").trim());
    if (rightMetric !== "custom" || hasCustomValue) {
        calculateOperationsComparison({ silent: true });
    }
}

document.addEventListener("calculatorSelectionChanged", event => {
    renderOperations(event.detail);
});

document.addEventListener("calculatorLoaded", () => {

    const fab = document.getElementById("essCalcFab");
    const calc = document.getElementById("essCalculator");
    const closeBtn = document.getElementById("essCalcClose");
    const minimizeBtn = document.getElementById("calcMinimize");
    const scientificKeys = document.getElementById("scientificKeys");

    const openCalculator = () => {
        calc.style.display = "block";
        window.essCalculator.render();
    };

    const closeCalculator = () => {
        calc.style.display = "none";
    };

    if (fab && calc) {
        fab.onclick = () => {
            if (calc.style.display === "block") closeCalculator();
            else openCalculator();
        };
    }

    closeBtn?.addEventListener("click", closeCalculator);
    minimizeBtn?.addEventListener("click", closeCalculator);

    document.querySelectorAll(".calc-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".calc-tab").forEach(item => item.classList.remove("active"));
            document.querySelectorAll(".calc-page").forEach(page => page.classList.remove("active"));

            tab.classList.add("active");
            document.getElementById(`${tab.dataset.tab}Tab`)?.classList.add("active");
        });
    });

    document.querySelectorAll(".calc-mode").forEach(mode => {
        mode.addEventListener("click", () => {
            document.querySelectorAll(".calc-mode").forEach(item => item.classList.remove("active"));
            mode.classList.add("active");
            scientificKeys?.classList.toggle("scientific-hidden", mode.dataset.mode !== "scientific");
        });
    });

    document.querySelectorAll(".calc-key").forEach(key => {
        key.addEventListener("click", () => {
            const action = key.dataset.action;
            const value = key.dataset.value;
            const calculator = window.essCalculator;

            if (action === "number") calculator.inputNumber(value);
            if (action === "decimal") calculator.inputDecimal();
            if (action === "operator") calculator.chooseOperator(value);
            if (action === "equals") calculator.equals();
            if (action === "clear") calculator.clear();
            if (action === "backspace") calculator.backspace();
            if (action === "sign") calculator.toggleSign();
            if (action === "fn") calculator.applyFunction(value);
            if (action === "constant") calculator.setConstant(value);

            calculator.render();
        });
    });

    document.addEventListener("keydown", event => {
        if (!calc || calc.style.display !== "block") return;
        if (event.target.matches("input, textarea, select")) return;

        const calculator = window.essCalculator;
        const key = event.key;

        if (/^\d$/.test(key)) calculator.inputNumber(key);
        else if (key === ".") calculator.inputDecimal();
        else if (["+", "-", "*", "/"].includes(key)) calculator.chooseOperator(key);
        else if (key === "Enter" || key === "=") calculator.equals();
        else if (key === "Backspace") calculator.backspace();
        else if (key === "Escape") closeCalculator();
        else return;

        event.preventDefault();
        calculator.render();
    });

    document.getElementById("opsCompareRight")?.addEventListener("change", () => {
        syncOperationsCustomAmountField();
        resetOperationsComparison();
    });

    document.getElementById("opsRunCompare")?.addEventListener("click", () => {
        calculateOperationsComparison();
    });

    document.getElementById("opsCustomAmount")?.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        calculateOperationsComparison();
    });

    document.getElementById("opsAnalysisMetric")?.addEventListener("change", () => {
        renderOperationsAnalysis();
    });

    document.getElementById("opsUseResult")?.addEventListener("click", () => {
        if (!operationsLastResult || !Number.isFinite(operationsLastResult.value)) return;

        const calculator = window.essCalculator;
        calculator.current = String(operationsLastResult.value);
        calculator.previous = null;
        calculator.operator = null;
        calculator.waitingForOperand = true;
        calculator.addHistory(operationsLastResult.expression, operationsLastResult.value);
        calculator.render();

        document.querySelectorAll(".calc-tab").forEach(tab => {
            tab.classList.toggle("active", tab.dataset.tab === "calculator");
        });
        document.querySelectorAll(".calc-page").forEach(page => {
            page.classList.toggle("active", page.id === "calculatorTab");
        });
    });

    syncOperationsCustomAmountField();
    renderOperations();

    if (typeof window.updateCalculatorSelectedRowsTotal === "function") {
        window.updateCalculatorSelectedRowsTotal();
    }

    window.essCalculator.render();
});
