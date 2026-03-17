console.log("SecureVault Content Script Loaded");

// 🔐 GLOBAL TRUST SCORE
let trustScore = 100;

// 🎨 Create overlay UI
function showOverlay(message) {

    let overlay = document.createElement("div");
    overlay.innerText = message;

    overlay.style.position = "fixed";
    overlay.style.top = "20px";
    overlay.style.right = "20px";
    overlay.style.padding = "12px 18px";
    overlay.style.backgroundColor = "#ff4d4d";
    overlay.style.color = "white";
    overlay.style.fontSize = "14px";
    overlay.style.borderRadius = "8px";
    overlay.style.zIndex = "999999";
    overlay.style.boxShadow = "0 0 10px rgba(0,0,0,0.3)";
    overlay.style.fontFamily = "Arial";

    document.body.appendChild(overlay);

    setTimeout(() => {
        overlay.remove();
    }, 2000);
}

// 🧠 Page sensitivity detection
function isSensitivePage() {
    const url = window.location.href.toLowerCase();

    return (
        url.includes("login") ||
        url.includes("signin") ||
        url.includes("bank") ||
        url.includes("account") ||
        url.includes("mail")
    );
}

function detectPasswordFields() {
    const passwordInputs = document.querySelectorAll('input[type="password"]');

    passwordInputs.forEach((input) => {

        if (input.dataset.securevaultProcessed) return;

        console.log("New password field detected!");

        input.style.border = "3px solid orange";
        input.dataset.securevaultProcessed = "true";

        let lastInputTime = 0;
        let lastLength = 0;

        // Focus
        input.addEventListener("focus", () => {
            console.log("Password field focused");

            chrome.runtime.sendMessage({
                type: "PASSWORD_FOCUS",
                url: window.location.href
            });
        });

        // Input logic
        input.addEventListener("input", () => {

            const currentTime = Date.now();
            const timeDiff = currentTime - lastInputTime;
            const currentLength = input.value.length;

            let suspicious = false;

            // ⚠️ Fast typing
            if (timeDiff < 50 && currentLength > 1) {
                suspicious = true;
            }

            // ⚠️ Paste detection
            if (currentLength - lastLength > 3) {
                suspicious = true;
            }

            // 🧠 Sensitivity boost
            if (isSensitivePage()) {
                if (timeDiff < 80) suspicious = true; // stricter
            }

            // 🔐 Trust score system
            if (suspicious) {
                trustScore -= 20;
            } else {
                trustScore = Math.min(100, trustScore + 1);
            }

            console.log("Trust Score:", trustScore);

            // 🚨 RESPONSE SYSTEM
            if (suspicious || trustScore < 60) {

                console.log("🚨 Protection triggered!");

                input.disabled = true;
                input.style.border = "3px solid red";

                showOverlay("⚠️ Suspicious activity detected!");

                setTimeout(() => {
                    input.disabled = false;
                    input.style.border = "3px solid orange";
                }, 2000);
            }

            lastInputTime = currentTime;
            lastLength = currentLength;

            chrome.runtime.sendMessage({
                type: "PASSWORD_INPUT",
                length: currentLength,
                suspicious: suspicious,
                trustScore: trustScore
            });
        });
    });
}

// Observer
function initObserver() {

    detectPasswordFields();

    const observer = new MutationObserver(() => {
        detectPasswordFields();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
}

// Init safely
if (document.body) {
    initObserver();
} else {
    window.addEventListener("DOMContentLoaded", initObserver);
}