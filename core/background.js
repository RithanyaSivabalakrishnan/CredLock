console.log("SecureVault Background Running");

// Listen for messages (like system calls)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    
    console.log("Message received in background:");
    console.log(message);

    if (message.type === "CONTENT_LOADED") {
        console.log("Page loaded:", message.url);
    }
});