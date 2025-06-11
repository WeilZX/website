document.addEventListener('DOMContentLoaded', function() {
    const navbarHtml = `
        <h1>Weil's Website</h1>
        <nav class="navbar">
            <ul>
                <li><a href="index.html">Home</a></li>
                <li><a href="soon.html">Interests</a></li>
                <li><a href="Clocktower.html">Clocks</a></li>
            </ul>
        </nav>
    `;
    document.getElementById('navbar-placeholder').innerHTML = navbarHtml;
});