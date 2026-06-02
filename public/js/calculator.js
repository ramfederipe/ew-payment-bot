class ESSCalculator {
    constructor() {
        this.current = "0";
        this.previous = null;
        this.operator = null;
        this.waitingForOperand = false;
        this.history = [];
    }

    inputNumber(value) {
        if (this.waitingForOperand) {
            this.current = value;
            this.waitingForOperand = false;
            return;
        }

        this.current = this.current === "0" ? value : `${this.current}${value}`;
    }

    inputDecimal() {
        if (this.waitingForOperand) {
            this.current = "0.";
            this.waitingForOperand = false;
            return;
        }

        if (!this.current.includes(".")) this.current += ".";
    }

    chooseOperator(nextOperator) {
        const value = Number(this.current);

        if (this.operator && this.waitingForOperand) {
            this.operator = nextOperator;
            this.render();
            return;
        }

        if (this.previous === null) {
            this.previous = value;
        } else if (this.operator) {
            const result = this.calculate(this.previous, value, this.operator);
            this.addHistory(`${this.format(this.previous)} ${this.operatorLabel(this.operator)} ${this.format(value)}`, result);
            this.current = String(result);
            this.previous = result;
        }

        this.operator = nextOperator;
        this.waitingForOperand = true;
    }

    calculate(first, second, operator) {
        if (operator === "+") return first + second;
        if (operator === "-") return first - second;
        if (operator === "*") return first * second;
        if (operator === "/") return second === 0 ? NaN : first / second;
        return second;
    }

    equals() {
        if (!this.operator || this.previous === null) return;

        const second = Number(this.current);
        const result = this.calculate(this.previous, second, this.operator);
        this.addHistory(`${this.format(this.previous)} ${this.operatorLabel(this.operator)} ${this.format(second)}`, result);

        this.current = Number.isFinite(result) ? String(result) : "Error";
        this.previous = null;
        this.operator = null;
        this.waitingForOperand = true;
    }

    applyFunction(name) {
        const value = Number(this.current);
        let result = value;
        let label = name;

        if (name === "sqrt") result = value < 0 ? NaN : Math.sqrt(value);
        if (name === "square") result = value * value;
        if (name === "percent") result = value / 100;
        if (name === "sin") result = Math.sin(value * Math.PI / 180);
        if (name === "cos") result = Math.cos(value * Math.PI / 180);
        if (name === "tan") result = Math.tan(value * Math.PI / 180);

        if (name === "square") label = "square";
        this.addHistory(`${label}(${this.format(value)})`, result);
        this.current = Number.isFinite(result) ? String(result) : "Error";
        this.waitingForOperand = true;
    }

    setConstant(name) {
        this.current = name === "pi" ? String(Math.PI) : String(Math.E);
        this.waitingForOperand = true;
    }

    toggleSign() {
        if (this.current === "0" || this.current === "Error") return;
        this.current = this.current.startsWith("-")
            ? this.current.slice(1)
            : `-${this.current}`;
    }

    backspace() {
        if (this.waitingForOperand || this.current === "Error") {
            this.current = "0";
            this.waitingForOperand = false;
            return;
        }

        this.current = this.current.length > 1 ? this.current.slice(0, -1) : "0";
    }

    clear() {
        this.current = "0";
        this.previous = null;
        this.operator = null;
        this.waitingForOperand = false;
    }

    operatorLabel(operator) {
        return operator === "*" ? "x" : operator;
    }

    format(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return "Error";
        return number.toLocaleString(undefined, { maximumFractionDigits: 10 });
    }

    addHistory(expression, result) {
        this.history.unshift({
            expression,
            result: this.format(result)
        });
        this.history = this.history.slice(0, 12);
    }

    getExpression() {
        if (this.previous === null || !this.operator) return "";
        return `${this.format(this.previous)} ${this.operatorLabel(this.operator)}`;
    }

    render() {
        const display = document.getElementById("essCalcDisplay");
        const expression = document.getElementById("calcExpression");
        const historyList = document.getElementById("calcHistoryList");

        if (display) display.innerText = this.format(this.current);
        if (expression) expression.innerText = this.getExpression() || "0";
        if (historyList) {
            historyList.innerHTML = this.history.length
                ? this.history.map(item => `
                    <div class="calc-history-item">
                        <strong>${item.expression}</strong>
                        <div>= ${item.result}</div>
                    </div>
                `).join("")
                : "No calculations yet";
            historyList.classList.toggle("calc-history-empty", !this.history.length);
        }
    }
}

window.essCalculator = new ESSCalculator();
