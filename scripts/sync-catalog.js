// scripts/sync-catalog.js
const admin = require('firebase-admin');
const fs = require('fs');

// 1. SECURE POINTS CONFIGURATION (Server-Side only)
const POINTS_CONFIG = {
    'new_product': 200,    // <-- إضافة نقاط المنتج الجديد
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
    
    // 3. Fetch all APPROVED contributions (لأننا الآن نراجعها في لوحة التحكم أولاً)
    const snapshot = await db.collection('contributions').where('status', '==', 'approved').get();
    
    if (snapshot.empty) {
        console.log("✅ No new approved contributions. Exiting.");
        return;
    }

    console.log(`⏳ [2/5] Found ${snapshot.docs.length} approved contributions to process.`);

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
        let isUpdateValid = false;

        // ==========================================
        // 🔹 أ. مسار إضافة منتج جديد كلياً
        // ==========================================
        if (data.field === 'new_product') {
            const newProd = data.proposedValue || {};
            
            // توليد ID فريد للمنتج الجديد
            const uniqueId = `prod_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            
            // إضافة المنتج الجديد إلى مصفوفة الكتالوج
            catalog.push({
                id: uniqueId,
                brand: newProd.brand || "Unknown Brand",
                name: newProd.name || "Unknown Product",
                category: newProd.category || { id: 'other', label: 'غير محدد', icon: 'box' },
                ingredients: "", // فارغ ليتم إضافته لاحقاً عبر نظام المكافآت
                image: "", // فارغ
                price: null,
                quantity: null,
                country: null,
                marketingClaims:[],
                targetTypes:[]
            });
            
            isUpdateValid = true;
            console.log(`✨ Created New Product: [${newProd.brand}] ${newProd.name} (ID: ${uniqueId})`);
        } 
        // ==========================================
        // 🔹 ب. مسار تحديث منتج موجود مسبقاً
        // ==========================================
        else {
            const productIndex = catalog.findIndex(p => p.id === data.productId);

            if (productIndex === -1) {
                console.warn(`⚠️ Warning: Product ID [${data.productId}] not found. Skipping.`);
                batch.delete(doc.ref);
                return; // قفز إلى المساهمة التالية
            }

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
        }

        // ==========================================
        // 🔹 ج. منح النقاط وحذف المساهمة
        // ==========================================
        if (isUpdateValid && data.userId) {
            
            // ⚠️ ملاحظة: إذا كنت تمنح النقاط لحظياً عبر Supabase، قم بتعليق (Comment) الأسطر الـ 6 القادمة!
            const pointsToAward = POINTS_CONFIG[data.field] || POINTS_CONFIG.default;
            const userRef = db.collection('profiles').doc(data.userId);
            
            batch.set(userRef, { 
                points: admin.firestore.FieldValue.increment(pointsToAward),
                lastContributionAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            pointsAwardedTotal += pointsToAward;
            // ----------------------------------------------------------------------------------------

            updatesCount++;
            console.log(`🏆 Processed ${data.field} for user ${data.userId}`);
        }

        // مسح المساهمة من قاعدة البيانات (Firestore) بمجرد دمجها بنجاح للحفاظ على نظافة الـ Database
        batch.delete(doc.ref);
    });

    console.log(`💾 [3/5] Saving ${updatesCount} updates to catalog file...`);
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

    console.log(`🔥[4/5] Committing to Firestore (Updates + Deletions)...`);
    await batch.commit();

    console.log(`🚀 [5/5] Success! Merged: ${updatesCount}, Total Points Added Here: ${pointsAwardedTotal}`);
}

run().catch(error => {
    console.error("❌ Fatal Script Error:", error);
});
