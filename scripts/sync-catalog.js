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
            // --- UPDATE PRICE FIELD (Smart Handling) ---
            if (data.field === 'price') {
                const newPrice = Number(data.proposedValue);
                
                // التأكد من أن القيمة المرسلة رقم صحيح وأكبر من الصفر
                if (!isNaN(newPrice) && newPrice > 0) {
                    let currentPrice = catalog[productIndex].price;

                    // الحالة 1: السعر الحالي null أو مجرد رقم (تحويله إلى كائن منظم)
                    if (!currentPrice || typeof currentPrice !== 'object') {
                        const oldVal = (Number(currentPrice) > 0) ? Number(currentPrice) : newPrice;
                        catalog[productIndex].price = {
                            min: Math.min(oldVal, newPrice),
                            max: Math.max(oldVal, newPrice),
                            currency: "DZD"
                        };
                    } 
                    // الحالة 2: السعر الحالي عبارة عن كائن {min, max, currency}
                    else {
                        // معالجة القيم الأولية إذا كانت null أو 0 لتجنب الأخطاء الحسابية
                        const currentMin = (currentPrice.min === null || currentPrice.min === 0) ? newPrice : Number(currentPrice.min);
                        const currentMax = (currentPrice.max === null || currentPrice.max === 0) ? newPrice : Number(currentPrice.max);

                        catalog[productIndex].price = {
                            min: Math.min(currentMin, newPrice),
                            max: Math.max(currentMax, newPrice),
                            currency: currentPrice.currency || "DZD"
                        };
                    }
                    updatesCount++;
                }
            } 
            // --- UPDATE OTHER FIELDS (Ingredients, Claims, etc.) ---
            else {
                catalog[productIndex][data.field] = data.proposedValue;
                updatesCount++;
            }
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
