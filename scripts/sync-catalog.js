// scripts/sync-catalog.js
const admin = require('firebase-admin');
const fs = require('fs');

// 1. Initialize Firebase securely using GitHub Secrets
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function run() {
    console.log("🔍 Checking for new contributions...");
    
    // 2. Fetch pending contributions
    const snapshot = await db.collection('contributions').where('status', '==', 'pending').get();
    
    if (snapshot.empty) {
        console.log("✅ No new contributions. Exiting.");
        return;
    }

    // 3. Load your current catalog
    const catalogPath = './finalcatalog506.json';
    let catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const batch = db.batch();
    let updatesCount = 0;

    // 4. Process each contribution
    snapshot.forEach(doc => {
        const data = doc.data();
        const productIndex = catalog.findIndex(p => p.id === data.productId);

        if (productIndex !== -1) {
            // Update the product field (e.g., price)
            if (data.field === 'price') {
                // If you want a min/max system for prices
                const currentPrice = catalog[productIndex].price;
                const newPrice = Number(data.proposedValue);
                
                if (!currentPrice) {
                    catalog[productIndex].price = { min: newPrice, max: newPrice };
                } else if (typeof currentPrice === 'object') {
                    catalog[productIndex].price.min = Math.min(currentPrice.min, newPrice);
                    catalog[productIndex].price.max = Math.max(currentPrice.max, newPrice);
                } else {
                    catalog[productIndex].price = newPrice;
                }
            } else {
                // For other fields like ingredients or targetTypes
                catalog[productIndex][data.field] = data.proposedValue;
            }

            updatesCount++;
        }

        // Mark this contribution as merged so we don't process it again
        batch.update(doc.ref, { 
            status: 'merged', 
            mergedAt: admin.firestore.FieldValue.serverTimestamp() 
        });
    });

    // 5. Save the updated JSON back to the file
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

    // 6. Tell Firebase these have been merged
    await batch.commit();
    console.log(`🚀 Successfully merged ${updatesCount} updates into catalog!`);
}

run().catch(console.error);
