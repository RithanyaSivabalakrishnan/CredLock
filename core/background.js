console.log("SecureVault Background Running");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    console.log("Message received:");
    console.log(message);

    if (message.type === "PASSWORD_INPUT") {

        console.log("Typing length:", message.length);
        console.log("Trust Score:", message.trustScore);

        if (message.suspicious) {
            console.log("🚨 Suspicious behavior detected!");
        }

        if (message.trustScore < 60) {
            console.log("⚠️ LOW TRUST USER");
        }
    }
});