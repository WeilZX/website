document.addEventListener('DOMContentLoaded', function() {
    const navbarHtml = `
        <h1>Weil's Website</h1>
        <nav class="navbar">
            <ul>
                <li><a href="">Home</a></li>
                <li><a href="soon.html">Interests...</a></li>
                <li><a href="clocks/clock-v1.html">Web Clock (Nayuki)</a></li>
                <li><a href="clocks/clock-v2.html">Web Clock (Claude)</a></li>
                <li><a href="clocks/clock-v3.html">Web Clock v3</a></li>
            </ul>
        </nav>
    `;
    document.getElementById('navbar-placeholder').innerHTML = navbarHtml;
});