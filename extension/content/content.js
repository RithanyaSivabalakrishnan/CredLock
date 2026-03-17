console.log("SecureVault Content Script Loaded");

// Visual confirmation (so you KNOW it's working)
document.body.style.border = "5px solid red";

// Send message to background (important for next step)
chrome.runtime.sendMessage({
    type: "CONTENT_LOADED",
    url: window.location.href
});