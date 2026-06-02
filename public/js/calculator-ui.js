(async function () {

    const response = await fetch(
        "/components/calculator.html"
    );

    const html = await response.text();

    document.body.insertAdjacentHTML(
        "beforeend",
        html
    );

    document.dispatchEvent(
        new Event("calculatorLoaded")
    );

})();