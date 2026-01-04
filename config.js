
// IMPORTANT: Do NOT commit real keys to source control.
// Agents data plane uses Entra ID; do not call it directly from browser.
// We'll call a SWA serverless proxy at /api/plan instead.

window.MEALPLANNER_CONFIG = {
  // Your Foundry PROJECT endpoint (keep the /api/projects/<projectName>)
  endpoint: "https://mealplanneragent-resource.services.ai.azure.com/api/projects/mealplanneragent",

  // Your Agent ID from Foundry UI
  agentId: "agt_Sf3iR05Q8M3y0djsbAYwKk2W",

  amazonAffiliateTag: "r8life-20",

  starterCartItems: [
    { asin: "B07CVZRZTC", qty: 1 },
    { asin: "B08QYH3V7T", qty: 1 },
    { asin: "B085RXTP7V", qty: 1 },
    { asin: "B000VDV1UO", qty: 6 },
    { asin: "B01EJABASW", qty: 2 },
    { asin: "B0FBZHW4MB", qty: 1 },
    { asin: "B001XUPH6I", qty: 1 },
    { asin: "B00CMQD3TA", qty: 1 },
    { asin: "B004SQRNG6", qty: 2 },
    { asin: "B00N7JY5WK", qty: 1 },
    { asin: "B074H4SHGV", qty: 2 },
    { asin: "B07XW1TNXZ", qty: 1 },
    { asin: "B008U5OSTQ", qty: 2 },
  ],

  approvedPantry: {
    "Proteins": [
      "Pre-cooked grilled chicken strips (Amazon Fresh refrigerated)",
      "Egg Beaters (ASIN B004SQRNG6)",
      "Greek yogurt, large tub (e.g., Chobani 32 oz, ASIN B008U5OSTQ)",
      "Whey protein powder (e.g., ON Whey 2 lb, ASIN B085RXTP7V)",
      "Black beans (e.g., Goya, ASIN B000VDV1UO)"
    ],
    "Carbs / Starches": [
      "Microwavable rice cups",
      "Brown rice (Lundberg, ASIN B00N7JY5WK)",
      "Whole grain pasta (Barilla, ASIN B01EJABASW)",
      "Russet potatoes (ASIN B07XW1TNXZ)",
      "Oats (Quaker, ASIN B07CVZRZTC)"
    ],
    "Veggies & Fruits": [
      "Frozen broccoli (365, ASIN B074H4SHGV)",
      "Frozen mixed / stir-fry vegetables",
      "Pre-washed greens",
      "Frozen berries",
      "Bananas / apples / pineapple cups"
    ],
    "Sauces & Misc": [
      "Marinara (Rao’s, ASIN B0FBZHW4MB)",
      "Honey (Nature Nate’s, ASIN B00CMQD3TA)",
      "Salsa",
      "Olive oil spray",
      "Seasoning blends"
    ],
    "Snacks / Drinks": [
      "Almonds (Blue Diamond, ASIN B001XUPH6I)",
      "Greek yogurt cups",
      "Almond milk (Almond Breeze, ASIN B08QYH3V7T)"
    ]
  }
};
