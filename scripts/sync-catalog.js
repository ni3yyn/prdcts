// scripts/sync-catalog.js
const admin = require('firebase-admin');
const fs = require('fs');

// --- 1. SMART ID CONFIGURATION & MAPS ---
const idCountryMap = { 
    "Algeria": "DZ", 
    "Egypt": "EG", 
    "France": "FR", 
    "Germany": "DE",
    "Italy": "IT",
    "Turkey": "TR",
    "Spain": "ES",
    "USA": "US", 
    "Korea": "KR", 
    "Japan": "JP",
    "China": "CN",
    "UK": "UK", 
    "Tunisia": "TN",
    "Morocco": "MA",
    "UAE": "AE",
    "Jordan": "JO",
    "Canada": "CA",
    "Switzerland": "CH",
    "Poland": "PL",
    "Greece": "GR",
    "Sweden": "SE",
    "Other": "OT" 
};

const idCategoryMap = {
    "cleanser": "CLE", "body_wash": "BWA", "shampoo": "SHA",
    "conditioner": "CON", "skin_serum": "SSE", "hair_serum": "HSE",
    "face_mask": "FMA", "hair_mask": "HMA", "sunscreen": "SUN",
    "oil_replacement": "OIL", "moisturizer": "MOI", "eye_cream": "EYE",
    "mask": "MSK", "scrub": "SCR", "oil_blend": "OIB", 
    "lotion_cream": "LOT", "other": "OTH"
};

// --- 2. HELPER FUNCTIONS FOR SMART ID ---

/**
 * Cleans brand names for comparison (e.g., L'Oréal -> LOREAL)
 */
function normalizeText(text) {
    if (!text) return "";
    return text.normalize("NFD")
               .replace(/[\u0300-\u036f]/g, "")
               .replace(/[^a-zA-Z0-9]/g, '')
               .toUpperCase();
}

/**
 * Generates a unique Brand Code (3+ chars) resolving conflicts with different brands
 */
function getUniqueBrandCode(brand, catalog) {
    if (!brand) return "XXX";
    const cleanBrand = normalizeText(brand);
    let length = 3;
    let code = cleanBrand.substring(0, length);
    
    // Fallback if brand name is too short
    if (code.length < 3) code = code.padEnd(3, 'X');

    let conflict = true;
    let iteration = 0;

    while (conflict && iteration < 20) {
        conflict = false;
        for (let p of catalog) {
            // Extract the brand code part from existing ID (e.g., DZ-CLE-CER-001 -> CER)
            const parts = p.id ? p.id.split('-') : [];
            const existingBrandCode = parts.length >= 4 ? parts[2] : "";
            const existingBrandNormalized = normalizeText(p.brand || "");

            // If the code matches but the actual brand name is different, we have a conflict
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

/**
 * Generates the full ID: Country-Category-Brand-Sequence (e.g., FR-CLE-CER-001)
 */
function generateSmartId(newProd, catalog) {
    // 1. Get Country Code
    let countryCode = "OT";
    const inputCountry = newProd.country || "Other";
    for (const [name, code] of Object.entries(idCountryMap)) {
        if (inputCountry.toLowerCase().includes(name.toLowerCase())) {
            countryCode = code;
            break;
        }
    }

    // 2. Get Category Code
    const catCode = idCategoryMap[newProd.category?.id] || "OTH";

    // 3. Get Unique Brand Code
    const brandCode = getUniqueBrandCode(newProd.brand, catalog);

    // 4. Determine Sequence Number
    const prefix = `${countryCode}-${catCode}-${brandCode}-`;
    let maxNum = 0;

    catalog.forEach(p => {
        if (p.id && p.id.startsWith(prefix)) {
            const numPart = p.id.substring(prefix.length);
            const num = parseInt(numPart, 10);
            if (!isNaN(num) && num > maxNum) {
                maxNum = num;
            }
        }
    });

    const nextNum = (maxNum + 1).toString().padStart(3, '0');
    return prefix + nextNum;
}

// --- 3. MAIN EXECUTION LOGIC ---

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();

async function run() {
    console.log("🔍 [1/4] Checking for APPROVED contributions...");
    
    // Fetch only Approved contributions (reviewed by Admin)
    const snapshot = await db.collection('contributions').where('status', '==', 'approved').get();
    
    if (snapshot.empty) {
        console.log("✅ No new approved contributions. Exiting.");
        return;
    }

    console.log(`⏳ [2/4] Found ${snapshot.docs.length} contributions to merge.`);

    const catalogPath = './finalcatalog506.json';
    let catalog;
    try {
        catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    } catch (error) {
        console.error("❌ CRITICAL ERROR: Could not read catalog file.", error);
        return;
    }

    const batch = db.batch();
    let updatesCount = 0;

    snapshot.forEach(doc => {
        const data = doc.data();
        let isUpdateValid = false;

        // --- PATH A: NEW PRODUCT ---
        if (data.field === 'new_product') {
            const newProd = data.proposedValue || {};
            
            const smartId = generateSmartId(newProd, catalog);
            
            catalog.push({
                id: smartId,
                brand: newProd.brand || "Unknown Brand",
                name: newProd.name || "Unknown Product",
                image: newProd.image || "",
                ingredients: newProd.ingredients || "",
                country: newProd.country || "Unknown",
                category: {
                    id: newProd.category?.id || "other",
                    label: newProd.category?.label || "غير محدد",
                    icon: newProd.category?.icon || "box"
                },
                quantity: newProd.quantity || "null",
                price: newProd.price || null,
                targetTypes: newProd.targetTypes || [],
                marketingClaims: newProd.marketingClaims || []
            });
            
            isUpdateValid = true;
            console.log(`✨ Created: ${smartId} ([${newProd.brand}] ${newProd.name})`);
        } 
        
        // --- PATH B: EXISTING PRODUCT UPDATE ---
        else {
            const productIndex = catalog.findIndex(p => p.id === data.productId);

            if (productIndex === -1) {
                console.warn(`⚠️ Warning: Product ID [${data.productId}] not found in catalog. Deleting contribution.`);
                batch.delete(doc.ref);
                return;
            }

            switch (data.field) {
                case 'price':
                    const newPrice = Number(data.proposedValue);
                    if (!isNaN(newPrice) && newPrice > 0) {
                        let currentPrice = catalog[productIndex].price;
                        // Handle conversion from old number format to price object if necessary
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
                case 'image':
                    if (typeof data.proposedValue === 'string' && data.proposedValue.trim().length > 0) {
                        catalog[productIndex][data.field] = data.proposedValue.trim();
                        isUpdateValid = true;
                    }
                    break;

                case 'marketingClaims':
                case 'targetTypes':
                    if (Array.isArray(data.proposedValue)) {
                        catalog[productIndex][data.field] = data.proposedValue;
                        isUpdateValid = true;
                    }
                    break;

                default:
                    console.warn(`⚠️ Unknown field: "${data.field}"`);
            }
        }

        // --- CLEANUP & SYNC ---
        if (isUpdateValid) {
            updatesCount++;
        }

        // Always delete the approved contribution document from Firestore after processing
        batch.delete(doc.ref);
    });

    // 4. Save to Disk & Commit Deletions to Firestore
    console.log(`💾 [3/4] Saving ${updatesCount} updates to JSON file...`);
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

    console.log(`🔥 [4/4] Committing Firestore cleanup (deleting approved docs)...`);
    await batch.commit();

    console.log(`🚀 Task Complete. Successfully merged ${updatesCount} contributions.`);
}

run().catch(error => {
    console.error("❌ Fatal Script Error:", error);
});
