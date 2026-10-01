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

// ========== Field labels (used in both notifications) ==========
const FIELD_LABELS = {
    price: 'السعر',
    quantity: 'الحجم',
    ingredients: 'المكونات',
    marketingClaims: 'الإدعاءات التسويقية',
    targetTypes: 'الفئة المستهدفة',
    country: 'البلد',
    brand: 'الماركة',
    image: 'الصورة',
    new_product: 'منتج جديد',
};

// ========== Smart ID generation helpers ==========
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

// ========== Push notification helper ==========
async function sendExpoPush(pushToken, message) {
    if (!pushToken || !Expo.isExpoPushToken(pushToken)) {
        return false;
    }
    try {
        const expo = new Expo();
        const chunks = expo.chunkPushNotifications([message]);
        for (const chunk of chunks) {
            const receipts = await expo.sendPushNotificationsAsync(chunk);
            console.log(`📱 Notification receipts:`, receipts);
        }
        return true;
    } catch (err) {
        console.error(`❌ Failed to send push:`, err.message);
        return false;
    }
}

// ========== Points awarding & approval notification ==========
async function awardPointsAndNotify(userId, points, field, contributionId, productId) {
    const userRef = admin.firestore().collection('profiles').doc(userId);

    // Transaction: safely update points, prevent double awarding
    await admin.firestore().runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) {
            throw new Error(`User ${userId} not found`);
        }

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

    // Send push notification (fire and forget)
    try {
        const userDoc = await admin.firestore().collection('profiles').doc(userId).get();
        const pushToken = userDoc.data()?.expoPushToken;

        if (pushToken && Expo.isExpoPushToken(pushToken)) {
            const message = {
                to: pushToken,
                sound: 'default',
                title: '🎉 تمت مكافأتك، شكراً!',
                body: `تم اعتماد مساهمتك للكتالوج في ${
                    FIELD_LABELS[field] || 'المساهمة'
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
            await sendExpoPush(pushToken, message);
            console.log(`📱 Approval notification sent to user ${userId}`);
        } else {
            console.log(`📱 No valid push token for user ${userId}`);
        }
    } catch (notifyErr) {
        console.error(
            `Failed to send notification to user ${userId}:`,
            notifyErr.message
        );
    }
}

// ========== Rejection notification ==========
// ========== Rejection notification ==========
async function notifyRejection(userId, field, contributionId, reason, proposedValue, productId, catalog) {
    if (!userId) {
        console.log(`⚠️ Rejected contribution ${contributionId} has no userId. Skipping notification.`);
        return;
    }

    try {
        const userDoc = await admin.firestore().collection('profiles').doc(userId).get();
        if (!userDoc.exists) {
            console.log(`⚠️ User ${userId} not found. Skipping rejection notification.`);
            return;
        }
        const pushToken = userDoc.data()?.expoPushToken;

        if (!pushToken || !Expo.isExpoPushToken(pushToken)) {
            console.log(`📱 No valid push token for user ${userId} (rejection)`);
            return;
        }

        // ── Resolve the human-readable product name ───────────────────
        let productName = '';
        if (field === 'new_product') {
            // For new products, the name lives inside proposedValue
            productName =
                proposedValue?.name?.trim() ||
                proposedValue?.brand?.trim() ||
                '';
        } else {
            // For edits to existing products, look up the catalog by productId
            const matched = catalog.find((p) => p.id === productId);
            if (matched) {
                const brand = (matched.brand || '').trim();
                const name = (matched.name || '').trim();
                productName = brand && name ? `${brand} ${name}` : (name || brand);
            }
        }
        // Last-resort fallback
        if (!productName) productName = 'المنتج';

        const fieldLabel = FIELD_LABELS[field] || 'المساهمة';
        const cleanReason = (reason || '').trim() || 'لم يتم تحديد سبب واضح.';

        // Keep body within safe push length (~180 chars for Android/iOS)
        let body = `تم رفض مساهمتك بخصوص ${fieldLabel} (${productName}). السبب: ${cleanReason}`;
        if (body.length > 200) {
            body = body.substring(0, 197) + '...';
        }

        const message = {
            to: pushToken,
            sound: 'default',
            title: '⚠️ للأسف..',
            body,
            data: {
                type: 'contribution_declined',
                field,
                contributionId,
                productId: productId || 'new_product',
                productName,
                rejectionReason: cleanReason,
            },
            channelId: 'oilguard-smart',
        };

        await sendExpoPush(pushToken, message);
        console.log(`📱 Rejection notification sent to user ${userId} (${productName})`);
    } catch (notifyErr) {
        console.error(
            `Failed to send rejection notification to user ${userId}:`,
            notifyErr.message
        );
    }
}

// ========== Main execution ==========
async function run() {
    console.log('🔍 [1/5] Checking for APPROVED + DECLINED contributions...');

    // Two queries — Firestore has no OR across different values in a single where
    const approvedSnap = await admin
        .firestore()
        .collection('contributions')
        .where('status', '==', 'approved')
        .get();

    const declinedSnap = await admin
        .firestore()
        .collection('contributions')
        .where('status', '==', 'declined')
        .get();

    if (approvedSnap.empty && declinedSnap.empty) {
        console.log('✅ No pending contributions to process. Exiting.');
        return;
    }

    console.log(
        `⏳ [2/5] Found ${approvedSnap.docs.length} approved + ${declinedSnap.docs.length} declined.`
    );

    const catalogPath = './finalcatalog506.json';
    let catalog;
    try {
        catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    } catch (error) {
        console.error('❌ CRITICAL ERROR: Could not read catalog file.', error);
        return;
    }

    const batch = admin.firestore().batch();
    let approvedCount = 0;
    let declinedCount = 0;

    // ─────────────────────────────────────────────────────────────
    // A) Handle DECLINED contributions: notify + delete
    // ─────────────────────────────────────────────────────────────
    for (const docSnap of declinedSnap.docs) {
        const data = docSnap.data();
        const contributionId = docSnap.id;

        console.log(
            `🚫 Declined: ${contributionId} (field=${data.field}, user=${data.userId || 'n/a'})`
        );

        try {
            await notifyRejection(
                data.userId,
                data.field,
                contributionId,
                data.rejectionReason,
                data.proposedValue,
                data.productId,
                catalog
            );
            batch.delete(docSnap.ref);
            declinedCount++;
        } catch (err) {
            console.error(
                `❌ Failed to process declined contribution ${contributionId}:`,
                err.message
            );
            // Keep the doc for retry next run
        }
    }

    // ─────────────────────────────────────────────────────────────
    // B) Handle APPROVED contributions: merge + award + notify + delete
    // ─────────────────────────────────────────────────────────────
    for (const docSnap of approvedSnap.docs) {
        const data = docSnap.data();
        const contributionId = docSnap.id;
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
            productId = smartId;
            console.log(`✨ Created: ${smartId} ([${newProd.brand}] ${newProd.name})`);
        } else {
            const productIndex = catalog.findIndex((p) => p.id === productId);
            if (productIndex === -1) {
                console.warn(
                    `⚠️ Product ID [${productId}] not found. Deleting contribution.`
                );
                batch.delete(docSnap.ref);
                continue;
            }

            switch (field) {
                case 'price': {
                    const newPrice = Number(data.proposedValue);
                    if (!isNaN(newPrice) && newPrice > 0) {
                        let currentPrice = catalog[productIndex].price;
                        if (!currentPrice || typeof currentPrice !== 'object') {
                            const oldVal =
                                Number(currentPrice) > 0 ? Number(currentPrice) : newPrice;
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
                    if (
                        typeof data.proposedValue === 'string' &&
                        data.proposedValue.trim().length > 0
                    ) {
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

        // --- Award + notify, then queue deletion ---
        if (isUpdateValid) {
            try {
                await awardPointsAndNotify(
                    data.userId,
                    pointsToAward,
                    field,
                    contributionId,
                    productId
                );
                console.log(
                    `🏆 Awarded ${pointsToAward} points to user ${data.userId} for ${field}`
                );
                approvedCount++;
                batch.delete(docSnap.ref);
            } catch (error) {
                console.error(
                    `❌ Failed to award points for contribution ${contributionId}:`,
                    error.message
                );
                // Keep for retry
                continue;
            }
        } else {
            // Invalid data — delete silently (no points, no notify)
            batch.delete(docSnap.ref);
        }
    }

    // --- Save updated catalog to disk (only if there were approved merges) ---
    if (approvedCount > 0) {
        console.log(`💾 [3/5] Saving ${approvedCount} catalog updates to JSON file...`);
        fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
    } else {
        console.log(`💾 [3/5] No catalog changes to save.`);
    }

    // --- Commit deletions ---
    console.log(`🔥 [4/5] Committing Firestore cleanup...`);
    await batch.commit();

    console.log(
        `🚀 [5/5] Task Complete. Approved merged: ${approvedCount}. Declined notified: ${declinedCount}.`
    );
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
