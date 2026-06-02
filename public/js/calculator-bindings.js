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

    document.getElementById("compareSettlement")?.addEventListener("click", () => {
        const selectedTotal = Number(document.getElementById("selectedRowsTotal")?.innerText.replace(/,/g, "") || 0);
        const statementAmount = Number(document.getElementById("statementAmount")?.value || 0);
        const difference = statementAmount - selectedTotal;
        const output = document.getElementById("settlementDifference");

        if (output) {
            output.innerText = `Difference: ${difference.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            })}`;
        }
    });

    window.essCalculator.render();
});
