/**
 * PYC 2026 — Progress Stepper
 * Include this script on any page in the registration/accommodation flow.
 * Auto-detects the current page and renders the appropriate stepper.
 * 
 * Usage: <script src="/progress-stepper.js"></script>
 * Place it in the <head> or right after <body>.
 */
(function() {
    // Stepper CSS
    const css = `
        .pyc-stepper { max-width: 650px; margin: 0 auto 25px; padding: 0 15px; position: relative; z-index: 10; }
        .pyc-stepper-track { display: flex; align-items: flex-start; justify-content: space-between; position: relative; }
        .pyc-stepper-track::before { content: ''; position: absolute; top: 18px; left: 30px; right: 30px; height: 3px; background: rgba(255,255,255,0.08); z-index: 0; }
        .pyc-stepper-track::after { content: ''; position: absolute; top: 18px; left: 30px; height: 3px; background: linear-gradient(90deg, #d4a556, #e5b96a); z-index: 1; transition: width 0.5s ease; }
        .pyc-step { display: flex; flex-direction: column; align-items: center; position: relative; z-index: 2; flex: 1; }
        .pyc-step-dot { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-family: 'Montserrat', sans-serif; font-size: 0.85rem; font-weight: 700; transition: all 0.3s; border: 3px solid rgba(255,255,255,0.1); background: #1a2332; color: rgba(245,245,245,0.3); }
        .pyc-step.completed .pyc-step-dot { background: #d4a556; color: #1a2332; border-color: #d4a556; }
        .pyc-step.active .pyc-step-dot { background: rgba(212,165,86,0.15); color: #d4a556; border-color: #d4a556; box-shadow: 0 0 12px rgba(212,165,86,0.3); animation: pyc-pulse 2s infinite; }
        .pyc-step-label { margin-top: 8px; font-size: 0.7rem; font-family: 'Montserrat', sans-serif; color: rgba(245,245,245,0.3); text-align: center; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; max-width: 80px; line-height: 1.3; }
        .pyc-step.completed .pyc-step-label { color: #d4a556; }
        .pyc-step.active .pyc-step-label { color: rgba(245,245,245,0.85); }
        @keyframes pyc-pulse { 0%, 100% { box-shadow: 0 0 12px rgba(212,165,86,0.3); } 50% { box-shadow: 0 0 20px rgba(212,165,86,0.5); } }
        @media (max-width: 480px) { .pyc-step-dot { width: 30px; height: 30px; font-size: 0.75rem; } .pyc-step-label { font-size: 0.62rem; max-width: 65px; } }
    `;

    // Detect current page
    const path = window.location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';

    // Registration flow steps
    const REG_STEPS = [
        { label: 'Register', pages: ['/register'] },
        { label: 'Payment', pages: ['/payment'] },
        { label: 'Confirmed', pages: ['/success'] }
    ];

    // Accommodation flow steps
    const ACCOMM_STEPS = [
        { label: 'Book Lodging', pages: ['/accommodations'] },
        { label: 'Payment', pages: ['/accommodation-payment'] },
        { label: 'Reserved', pages: ['/accommodation-success'] }
    ];

    // Determine which flow and current step
    let steps = null;
    let currentIdx = -1;

    // Check registration flow
    REG_STEPS.forEach((step, i) => {
        if (step.pages.includes(path)) { steps = REG_STEPS; currentIdx = i; }
    });

    // Check accommodation flow
    if (!steps) {
        ACCOMM_STEPS.forEach((step, i) => {
            if (step.pages.includes(path)) { steps = ACCOMM_STEPS; currentIdx = i; }
        });
    }

    // If not on a tracked page, do nothing
    if (!steps || currentIdx === -1) return;

    // Calculate progress line width
    const progressPct = currentIdx === 0 ? 0 : (currentIdx / (steps.length - 1)) * 100;

    // Build HTML
    let stepsHtml = '';
    steps.forEach((step, i) => {
        const state = i < currentIdx ? 'completed' : i === currentIdx ? 'active' : '';
        const dotContent = i < currentIdx ? '✓' : (i + 1);
        stepsHtml += `<div class="pyc-step ${state}"><div class="pyc-step-dot">${dotContent}</div><div class="pyc-step-label">${step.label}</div></div>`;
    });

    const html = `<div class="pyc-stepper"><div class="pyc-stepper-track" style="--progress:${progressPct}%">${stepsHtml}</div></div>`;

    // Inject CSS
    const styleEl = document.createElement('style');
    styleEl.textContent = css + `\n.pyc-stepper-track::after { width: calc(${progressPct}%); }`;
    document.head.appendChild(styleEl);

    // Inject stepper into the page
    function inject() {
        // Find the container div
        const container = document.querySelector('.container');
        if (container) {
            const stepperDiv = document.createElement('div');
            stepperDiv.innerHTML = html;
            // Insert as first child of container (or after stars div)
            const firstChild = container.firstElementChild;
            if (firstChild) {
                container.insertBefore(stepperDiv.firstElementChild, firstChild);
            } else {
                container.appendChild(stepperDiv.firstElementChild);
            }
        }
    }

    // Run on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject);
    } else {
        inject();
    }
})();
