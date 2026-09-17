// Enough to prove the tunnel carries module requests and HMR, and nothing more.
document.querySelector('#served-by').textContent
    = `This page came through the dev tunnel at ${new Date().toISOString()}`;
