// scripts/sync-catalog.js
const admin = require('firebase-admin');
const fs = require('fs');
const { Expo } = require('expo-server-sdk');

// ========== Points mapping (must match getPointsForField on frontend) ==========
const POINTS_MAP = {
    price: 50,
    quantity: 30,
    ingredients: 100,
    marketingClaims: 40,
    targetTypes: 40,
    country: 25,
    new_product: 200,
};

// ========== Smart ID generation helpers (unchanged) ==========
const idCountryMap = {
    Algeria: 'DZ',
    Egypt: 'EG',
    France: 'FR',
    Germany: 'DE',
    Italy: 'IT',
    Turkey: 'TR',
    Spain: 'ES',
    USA: 'US',
    Korea: 'KR',
    Japan: 'JP',
    China: 'CN',
    UK: 'UK',
    Tunisia: 'TN',
    Morocco: 'MA',
    UAE: 'AE',
    Jordan: 'JO',
    Canada: 'CA',
    Switzerland: 'CH',
    Poland: 'PL',
    Greece: 'GR',
    Sweden: 'SE',
    Other: 'OT',
};

const idCategoryMap = {
    cleanser: 'CLE',
    body_wash: 'BWA',
    shampoo: 'SHA',
    conditioner: 'CON',
    skin_serum: 'SSE',
    hair_serum: 'HSE',
    face_mask: 'FMA',
    hair_mask: 'HMA',
    sunscreen: 'SUN',
    oil_replacement: 'OIL',
    moisturizer: 'MOI',
    eye_cream: 'EYE',
    mask: 'MSK',
    scrub: 'SCR',
    oil_blend: 'OIB',
    lotion_cream: 'LOT',
    other: 'OTH',
};

function normalizeText(text) {
    if (!text) return '';
    return text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .toUpperCase();
}

function getUniqueBrandCode(brand, catalog) {
    if (!brand) return 'XXX';
    const cleanBrand = normalizeText(brand);
    let length = 3;
    let code = cleanBrand.substring(0, length);
    if (code.length < 3) code = code.padEnd(3, 'X');

    let conflict = true;
    let iteration = 0;

    while (conflict && iteration < 20) {
        conflict = false;
        for (const p of catalog) {
            const parts = p.id ? p.id.split('-') : [];
            const existingBrandCode = parts.length >= 4 ? parts[2] : '';
            const existingBrandNormalized = normalizeText(p.brand || '');
            if (existingBrandCode === code && existingBrandNormalized !== cleanBrand) {
                conflict = true;
                break;
            }
        }
        if (conflict) {
            iteration++;
            if (length < cleanBrand.length) {
                length++;
                code = cleanBrand.substring(0, length);
            } else {
                code = cleanBrand.substring(0, length) + iteration;
            }
        }
    }
    return code;
}

function generateSmartId(newProd, catalog) {
    let countryCode = 'OT';
    const inputCountry = newProd.country || 'Other';
    for (const [name, code] of Object.entries(idCountryMap)) {
        if (inputCountry.toLowerCase().includes(name.toLowerCase())) {
            countryCode = code;
            break;
        }
    }

    const catCode = idCategoryMap[newProd.category?.id] || 'OTH';
    const brandCode = getUniqueBrandCode(newProd.brand, catalog);

    const prefix = `${countryCode}-${catCode}-${brandCode}-`;
    let maxNum = 0;
    catalog.forEach((p) => {
        if (p.id && p.id.startsWith(prefix)) {
            const numPart = p.id.substring(prefix.length);
            const num = parseInt(numPart, 10);
            if (!isNaN(num) && num > maxNum) maxNum = num;
        }
    });
    const nextNum = (maxNum + 1).toString().padStart(3, '0');
    return prefix + nextNum;
}

// ========== Points awarding & notification (NEW) ==========
async function awardPointsAndNotify(userId, points, field, contributionId, productId) {
    const userRef = admin.firestore().collection('profiles').doc(userId);

    // Use a transaction to safely update points and prevent double awarding
    await admin.firestore().runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) {
            throw new Error(`User ${userId} not found`);
        }

        // Idempotency check – don't award twice for the same contribution
        const pointsHistory = userDoc.data().pointsHistory || {};
        if (pointsHistory[contributionId]) {
            console.log(`⚠️ Contribution ${contributionId} already awarded. Skipping.`);
            return;
        }

        const currentPoints = userDoc.data().points || 0;
        transaction.update(userRef, {
            points: currentPoints + points,
            [`pointsHistory.${contributionId}`]: {
                points,
                field,
                productId: productId || 'new_product',
                awardedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
        });
    });

    // Send push notification (fire and forget – don't block on failure)
    try {
        const userDoc = await admin.firestore().collection('profiles').doc(userId).get();
        const pushToken = userDoc.data()?.expoPushToken;
        if (pushToken && Expo.isExpoPushToken(pushToken)) {
            const fieldLabels = {
                price: 'السعر',
                quantity: 'الحجم',
                ingredients: 'المكونات',
                marketingClaims: 'المميزات',
                targetTypes: 'الفئة المستهدفة',
                country: 'البلد',
                new_product: 'منتج جديد',
            };
            const message = {
                to: pushToken,
                sound: 'default',
                title: '🎉 تمت مكافأتك!',
                body: `تم اعتماد مساهمتك في ${
                    fieldLabels[field] || 'المساهمة'
                } وحصلت على ${points} نقطة!`,
                data: {
                    type: 'points_earned',
                    points,
                    field,
                    contributionId,
                    productId: productId || 'new_product',
                },
                channelId: 'oilguard-smart',
            };
            const chunks = Expo.chunkPushNotifications([message]);
            for (const chunk of chunks) {
                await Expo.sendPushNotificationsAsync(chunk);
            }
            console.log(`📱 Notification sent to user ${userId}`);
        } else {
            console.log(`📱 No valid push token for user ${userId}`);
        }
    } catch (notifyErr) {
        console.error(`Failed to send notification to user ${userId}:`, notifyErr.message);
    }
}

// ========== Main execution ==========
async function run() {
    console.log('🔍 [1/4] Checking for APPROVED contributions...');

    const snapshot = await admin
        .firestore()
        .collection('contributions')
        .where('status', '==', 'approved')
        .get();

    if (snapshot.empty) {
        console.log('✅ No new approved contributions. Exiting.');
        return;
    }

    console.log(`⏳ [2/4] Found ${snapshot.docs.length} contributions to merge.`);

    const catalogPath = './finalcatalog506.json';
    let catalog;
    try {
        catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    } catch (error) {
        console.error('❌ CRITICAL ERROR: Could not read catalog file.', error);
        return;
    }

    const batch = admin.firestore().batch();
    let updatesCount = 0;

    // Process contributions one by one to ensure points are awarded before deletion
    for (const doc of snapshot.docs) {
        const data = doc.data();
        const contributionId = doc.id;
        let isUpdateValid = false;
        let pointsToAward = 0;
        const field = data.field;
        let productId = data.productId;

        // --- Apply the update to the catalog (in memory) ---
        if (field === 'new_product') {
            const newProd = data.proposedValue || {};
            const smartId = generateSmartId(newProd, catalog);
            catalog.push({
                id: smartId,
                brand: newProd.brand || 'Unknown Brand',
                name: newProd.name || 'Unknown Product',
                image: newProd.image || '',
                ingredients: newProd.ingredients || '',
                country: newProd.country || 'Unknown',
                category: {
                    id: newProd.category?.id || 'other',
                    label: newProd.category?.label || 'غير محدد',
                    icon: newProd.category?.icon || 'box',
                },
                quantity: newProd.quantity || 'null',
                price: newProd.price || null,
                targetTypes: newProd.targetTypes || [],
                marketingClaims: newProd.marketingClaims || [],
            });
            isUpdateValid = true;
            pointsToAward = POINTS_MAP.new_product;
            productId = smartId; // assign the new ID for later reference
            console.log(`✨ Created: ${smartId} ([${newProd.brand}] ${newProd.name})`);
        } else {
            const productIndex = catalog.findIndex((p) => p.id === productId);
            if (productIndex === -1) {
                console.warn(`⚠️ Product ID [${productId}] not found. Deleting contribution.`);
                batch.delete(doc.ref);
                continue;
            }

            switch (field) {
                case 'price': {
                    const newPrice = Number(data.proposedValue);
                    if (!isNaN(newPrice) && newPrice > 0) {
                        let currentPrice = catalog[productIndex].price;
                        if (!currentPrice || typeof currentPrice !== 'object') {
                            const oldVal = Number(currentPrice) > 0 ? Number(currentPrice) : newPrice;
                            catalog[productIndex].price = {
                                min: Math.min(oldVal, newPrice),
                                max: Math.max(oldVal, newPrice),
                                currency: 'DZD',
                            };
                        } else {
                            catalog[productIndex].price.min = Math.min(
                                currentPrice.min || newPrice,
                                newPrice
                            );
                            catalog[productIndex].price.max = Math.max(
                                currentPrice.max || newPrice,
                                newPrice
                            );
                        }
                        isUpdateValid = true;
                        pointsToAward = POINTS_MAP.price;
                    }
                    break;
                }
                case 'ingredients':
                case 'quantity':
                case 'country':
                case 'brand':
                case 'image':
                    if (typeof data.proposedValue === 'string' && data.proposedValue.trim().length > 0) {
                        catalog[productIndex][field] = data.proposedValue.trim();
                        isUpdateValid = true;
                        pointsToAward = POINTS_MAP[field];
                    }
                    break;
                case 'marketingClaims':
                case 'targetTypes':
                    if (Array.isArray(data.proposedValue)) {
                        catalog[productIndex][field] = data.proposedValue;
                        isUpdateValid = true;
                        pointsToAward = POINTS_MAP[field];
                    }
                    break;
                default:
                    console.warn(`⚠️ Unknown field: "${field}"`);
            }
        }

        // --- If the update is valid, award points and notify ---
        if (isUpdateValid) {
            try {
                await awardPointsAndNotify(data.userId, pointsToAward, field, contributionId, productId);
                console.log(`🏆 Awarded ${pointsToAward} points to user ${data.userId} for ${field}`);
                updatesCount++;
                // Only delete the contribution after points are awarded successfully
                batch.delete(doc.ref);
            } catch (error) {
                console.error(
                    `❌ Failed to award points for contribution ${contributionId}:`,
                    error.message
                );
                // Do NOT delete the contribution; it will be retried next run
                continue;
            }
        } else {
            // Invalid data – just delete the contribution
            batch.delete(doc.ref);
        }
    }

    // --- Save updated catalog to disk ---
    console.log(`💾 [3/4] Saving ${updatesCount} updates to JSON file...`);
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

    // --- Commit deletions of processed contributions ---
    console.log(`🔥 [4/4] Committing Firestore cleanup (deleting processed docs)...`);
    await batch.commit();

    console.log(`🚀 Task Complete. Successfully merged ${updatesCount} contributions.`);
}

// Initialize Firebase Admin once
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

run().catch((error) => {
    console.error('❌ Fatal Script Error:', error);
    process.exit(1);
});
