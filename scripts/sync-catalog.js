// scripts/sync-catalog.js
const admin = require('firebase-admin');
const fs = require('fs');

// 1. Initialize Firebase securely using GitHub Secrets
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// تجنب إعادة تهيئة التطبيق إذا كان البوت يعمل في بيئة قد تستدعيه عدة مرات
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();

async function run() {
    console.log("🔍 [1/5] Checking for new contributions...");
    
    // 2. Fetch all pending contributions at once
    const snapshot = await db.collection('contributions').where('status', '==', 'pending').get();
    
    if (snapshot.empty) {
        console.log("✅ No new contributions. Exiting.");
        return;
    }

    console.log(`⏳ [2/5] Found ${snapshot.docs.length} new contributions to process.`);

    // 3. Load your current catalog safely
    const catalogPath = './finalcatalog506.json';
    let catalog;
    try {
        catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    } catch (error) {
        console.error("❌ CRITICAL ERROR: Could not read or parse the catalog file.", error);
        return; // الخروج فوراً إذا لم نتمكن من قراءة الكتالوج
    }

    const batch = db.batch();
    let updatesCount = 0;

    // 4. Process each contribution with dedicated logic for each field type
    snapshot.forEach(doc => {
        const data = doc.data();
        const productIndex = catalog.findIndex(p => p.id === data.productId);

        if (productIndex === -1) {
            console.warn(`⚠️ Warning: Product with ID [${data.productId}] not found in catalog. Skipping.`);
            // سنقوم بحذف هذه المساهمة اليتيمة لكي لا تتم معالجتها مجدداً
            batch.delete(doc.ref);
            return; // الانتقال للمساهمة التالية
        }

        // --- THE BRAIN: Use a switch statement for type-safe updates ---
        switch (data.field) {
            case 'price':
                const newPrice = Number(data.proposedValue);
                if (isNaN(newPrice) || newPrice <= 0) break; // تجاهل السعر غير الصالح

                let currentPrice = catalog[productIndex].price;

                if (!currentPrice || typeof currentPrice !== 'object') {
                    // إذا كان السعر قديماً (رقم أو null)، قم بإنشاء الكائن الجديد
                    const oldVal = (Number(currentPrice) > 0) ? Number(currentPrice) : newPrice;
                    catalog[productIndex].price = {
                        min: Math.min(oldVal, newPrice),
                        max: Math.max(oldVal, newPrice),
                        currency: "DZD"
                    };
                } else {
                    // إذا كان السعر كائناً، قم بتحديثه بشكل آمن
                    const currentMin = (currentPrice.min > 0) ? currentPrice.min : newPrice;
                    const currentMax = (currentPrice.max > 0) ? currentPrice.max : newPrice;
                    catalog[productIndex].price = {
                        min: Math.min(currentMin, newPrice),
                        max: Math.max(currentMax, newPrice),
                        currency: currentPrice.currency || "DZD"
                    };
                }
                updatesCount++;
                break;

            case 'ingredients':
            case 'quantity':
            case 'country':
            case 'brand':
                // هذه الحقول هي مجرد نصوص، يمكن تعيينها مباشرة
                if (typeof data.proposedValue === 'string' && data.proposedValue.trim().length > 0) {
                    catalog[productIndex][data.field] = data.proposedValue;
                    updatesCount++;
                }
                break;

            case 'marketingClaims':
            case 'targetTypes':
                // هذه الحقول هي مصفوفات (Arrays)
                if (Array.isArray(data.proposedValue)) {
                    catalog[productIndex][data.field] = data.proposedValue;
                    updatesCount++;
                }
                break;

            default:
                console.warn(`⚠️ Warning: Unknown field type "${data.field}". Skipping.`);
        }

        // We will delete the contribution after merging it to keep the database clean
        batch.delete(doc.ref);
    });

    console.log(`💾 [3/5] Saving ${updatesCount} updates to the JSON file...`);
    // 5. Save the updated JSON back to the file
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

    console.log(`🔥 [4/5] Committing changes to Firestore (deleting processed contributions)...`);
    // 6. Commit the batch (deleting all processed documents)
    await batch.commit();

    console.log(`🚀 [5/5] Successfully merged ${updatesCount} updates into catalog!`);
}

run().catch(error => {
    console.error("❌ An unexpected error occurred during the script execution:", error);
});
