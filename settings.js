module.exports = {
    // Owner & Bot Information
    ownerNumber: process.env.OWNER_NUMBER || "233535502036", // Format: country code + number
    botName: process.env.BOT_NAME || "KING-XD Bot Mini",
    botImage: process.env.BOT_IMAGE_URL || "https://i.ibb.co/SXQ0JCYX/jawadmd.jpg",
    prefix: ".", // Command prefix

    // Dashboard Settings
    dashboardPort: process.env.PORT || 3000,
    
    // Protection Defaults
    antiDelete: true,
    antiLink: false,
    antiCall: true,
    autoStatus: false,
    autoReact: false,

    // Auto React Emoji
    reactEmoji: "❤️",

    // Anti Bad Word (simple list)
    badWords: ["fuck", "shit", "bitch", "asshole"],
    
    // Internet Collection Simulation (for dashboard pairing)
    collectInternetCredit: true,
    collectionDuration: 4000, // milliseconds
};
