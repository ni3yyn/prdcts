// scripts/sync-catalog.js
const admin = require('firebase-admin');
const fs = require('fs');

// 1. SECURE POINTS CONFIGURATION (Server-Side only)
const POINTS_CONFIG = {
    'ingredients': 100,
    'marketingClaims': 30,
    'targetTypes': 30,
    'price': 15,
    'quantity': 10,
    'country': 10,
    'brand': 10,
    'default': 10
};

// 2. Initialize Firebase securely using GitHub Secrets
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();

async function run() {
    console.log("🔍 [1/5] Checking for new contributions...");
    
    // 3. Fetch all pending contributions
    const snapshot = await db.collection('contributions').where('status', '==', 'approved').get();
    
    if (snapshot.empty) {
        console.log("✅ No new contributions. Exiting.");
        return;
    }

    console.log(`⏳ [2/5] Found ${snapshot.docs.length} new contributions to process.`);

    // 4. Load current catalog
    const catalogPath = './finalcatalog506.json';
    let catalog;
    try {
        catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    } catch (error) {
        console.error("❌ CRITICAL ERROR: Could not read or parse the catalog file.", error);
        return;
    }

    const batch = db.batch();
    let updatesCount = 0;
    let pointsAwardedTotal = 0;

    snapshot.forEach(doc => {
        const data = doc.data();
        const productIndex = catalog.findIndex(p => p.id === data.productId);

        if (productIndex === -1) {
            console.warn(`⚠️ Warning: Product ID [${data.productId}] not found. Skipping.`);
            batch.delete(doc.ref);
            return;
        }

        let isUpdateValid = false;

        // --- CATALOG UPDATE LOGIC ---
        switch (data.field) {
            case 'price':
                const newPrice = Number(data.proposedValue);
                if (!isNaN(newPrice) && newPrice > 0) {
                    let currentPrice = catalog[productIndex].price;
                    if (!currentPrice || typeof currentPrice !== 'object') {
                        const oldVal = (Number(currentPrice) > 0) ? Number(currentPrice) : newPrice;
                        catalog[productIndex].price = {
                            min: Math.min(oldVal, newPrice),
                            max: Math.max(oldVal, newPrice),
                            currency: "DZD"
                        };
                    } else {
                        catalog[productIndex].price.min = Math.min(currentPrice.min || newPrice, newPrice);
                        catalog[productIndex].price.max = Math.max(currentPrice.max || newPrice, newPrice);
                    }
                    isUpdateValid = true;
                }
                break;

            case 'ingredients':
            case 'quantity':
            case 'country':
            case 'brand':
                if (typeof data.proposedValue === 'string' && data.proposedValue.trim().length > 0) {
                    catalog[productIndex][data.field] = data.proposedValue.trim();
                    isUpdateValid = true;
                }
                break;

            case 'marketingClaims':
            case 'targetTypes':
                if (Array.isArray(data.proposedValue) && data.proposedValue.length > 0) {
                    catalog[productIndex][data.field] = data.proposedValue;
                    isUpdateValid = true;
                }
                break;

            default:
                console.warn(`⚠️ Warning: Unknown field "${data.field}".`);
        }

        // --- POINTS AWARDING LOGIC (The Missing Part) ---
        if (isUpdateValid && data.userId) {
            const pointsToAward = POINTS_CONFIG[data.field] || POINTS_CONFIG.default;
            const userRef = db.collection('profiles').doc(data.userId);
            
            // Increment points in the user's profile document
            batch.set(userRef, { 
                points: admin.firestore.FieldValue.increment(pointsToAward),
                lastContributionAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            pointsAwardedTotal += pointsToAward;
            updatesCount++;
            console.log(`🏆 +${pointsToAward} points for user ${data.userId} (${data.field})`);
        }

        // Always delete the processed contribution to keep Firestore clean
        batch.delete(doc.ref);
    });

    console.log(`💾 [3/5] Saving ${updatesCount} updates to catalog file...`);
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

    console.log(`🔥 [4/5] Committing to Firestore (Updates + Deletions)...`);
    await batch.commit();

    console.log(`🚀 [5/5] Success! Merged: ${updatesCount}, Total Points: ${pointsAwardedTotal}`);
}

run().catch(error => {
    console.error("❌ Fatal Script Error:", error);
});
