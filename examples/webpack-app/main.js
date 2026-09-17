// Enough to prove the tunnel carries bundled assets, and nothing more.
document.querySelector('#served-by').textContent
    = `This page came through the dev tunnel at ${new Date().toISOString()}`;
