const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");

// --- CONFIGURAZIONE ---
const TIMEOUT_MS = 15000; 
const USER_AGENT_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// --- URL BASE ---
const CORSARO_BASE_URL = "https://ilcorsaronero.link";
const KNABEN_BASE_URL = "https://knaben.org"; 
const UINDEX_BASE_URL = "https://uindex.org";

// Regex per intercettare Italiano
const ITA_REGEX = /\b(ITA|ITALIAN|ITALIANO|MULTI|DUAL|MD|SUB[\s._-]?ITA|FORCED|AC3[\s._-]?ITA|DTS[\s._-]?ITA|CINEFILE|NOVARIP|MEM|ROBBYRS|IDN_CREW|PSO|BADASS)\b/i;

// --- UTILITIES ---
function cleanString(str) {
    return str
        .replace(/[:"'’]/g, "")
        .replace(/[^a-zA-Z0-9\s\-.\[\]]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function extractInfoHash(magnet) {
    if (!magnet) return null;
    const match = magnet.match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
    return match ? match[1].toUpperCase() : null;
}

function extractQuality(title) {
    if (!title) return 'Unknown';
    const t = title.toLowerCase();
    if (t.includes('2160p') || t.includes('4k') || t.includes('uhd')) return '4k';
    if (t.includes('1080p') || t.includes('fhd')) return '1080p';
    if (t.includes('720p') || t.includes('hd')) return '720p';
    if (t.includes('480p') || t.includes('sd')) return 'SD';
    if (t.includes('dvdrip')) return 'DVD';
    if (t.includes('cam') || t.includes('ts')) return 'CAM';
    return 'Unknown';
}

function parseSize(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/([\d.,]+)\s*(GB|MB|KB|B)/i);
    if (!match) return 0;
    let val = parseFloat(match[1].replace(',', '.'));
    const unit = match[2].toUpperCase();
    if (unit === 'GB') val *= 1024 * 1024 * 1024;
    if (unit === 'MB') val *= 1024 * 1024;
    if (unit === 'KB') val *= 1024;
    return Math.round(val);
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/* ===========================================================
   🏴‍☠️ IL CORSARO NERO SEARCH
   =========================================================== */
async function searchCorsaro(query) {
    try {
        const searchUrl = `${CORSARO_BASE_URL}/search?q=${encodeURIComponent(query)}`;
        const { data } = await axios.get(searchUrl, {
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': USER_AGENT_DESKTOP }
        });

        const $ = cheerio.load(data);
        const rows = $('tbody tr').toArray();
        const results = [];

        for (const row of rows.slice(0, 8)) { 
            const titleEl = $(row).find('th a');
            const title = titleEl.text().trim();
            const url = titleEl.attr('href');
            const size = $(row).find('td').eq(3).text().trim();
            const seeds = parseInt($(row).find('td.text-green-500').text().trim()) || 0;

            if (!url) continue;

            try {
                const detailUrl = `${CORSARO_BASE_URL}${url}`;
                const detailRes = await axios.get(detailUrl, { 
                    timeout: 6000,
                    headers: { 'User-Agent': USER_AGENT_DESKTOP }
                });
                const $$ = cheerio.load(detailRes.data);
                
                let magnet = $$('a[href^="magnet:?"]').attr('href');
                if (!magnet) magnet = $$("div.w-full:nth-child(2) a").attr('href');

                if (magnet) {
                    results.push({
                        title,
                        magnet,
                        size: size || 'Unknown',
                        sizeBytes: parseSize(size),
                        seeders: seeds,
                        source: 'CorsaroNero',
                        quality: extractQuality(title)
                    });
                }
            } catch (e) { continue; }
        }
        return results;
    } catch (e) {
        console.error("❌ Corsaro Error:", e.message);
        return [];
    }
}

/* ===========================================================
   🦉 KNABEN SEARCH (HTML SCRAPER)
   =========================================================== */
async function searchKnaben(query) {
    try {
        const cleanQuery = cleanString(query);
        // Cerchiamo direttamente nella pagina HTML (categoria 0 = tutto, pagina 1)
        // 🔥 IMPORTANTE: Usiamo query PULITA (solo titolo), senza "ITA"
        const url = `${KNABEN_BASE_URL}/search/${encodeURIComponent(cleanQuery)}/0/1/seeders`;

        console.log(`🦉 Knaben URL: ${url}`);

        const ignoreSSL = new https.Agent({ rejectUnauthorized: false });
        
        const { data } = await axios.get(url, {
            timeout: TIMEOUT_MS,
            httpsAgent: ignoreSSL,
            headers: {
                'User-Agent': USER_AGENT_DESKTOP,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Referer': 'https://knaben.org/'
            }
        });

        const $ = cheerio.load(data);
        const rows = $('table tbody tr').toArray();
        
        if (rows.length === 0) {
            console.log("🦉 Knaben: HTML scaricato ma 0 risultati trovati.");
            return [];
        }

        const results = [];

        rows.forEach(row => {
            const cells = $(row).find('td');
            if (cells.length < 5) return;

            const titleLink = $(cells[1]).find('a').first();
            const title = titleLink.text().trim();
            const magnet = $(cells[1]).find('a[href^="magnet:"]').attr('href');
            const sizeStr = $(cells[2]).text().trim();
            const seeds = parseInt($(cells[4]).text().trim()) || 0;

            if (!title || !magnet) return;

            // 🔥 Rimosso filtro ITA Strict: accettiamo tutto da Knaben per avere i 4K globali
            results.push({
                title: title,
                magnet: magnet,
                size: sizeStr,
                sizeBytes: parseSize(sizeStr),
                seeders: seeds,
                source: 'Knaben',
                quality: extractQuality(title)
            });
        });

        console.log(`🦉 Knaben: trovati ${results.length} risultati.`);
        return results;

    } catch (e) {
        console.error("🦉 Knaben Error:", e.message);
        return [];
    }
}

/* ===========================================================
   📊 UINDEX SEARCH
   =========================================================== */
async function searchUIndex(query) {
    try {
        const url = `${UINDEX_BASE_URL}/search.php?search=${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, {
            timeout: TIMEOUT_MS,
            headers: { 'User-Agent': USER_AGENT_DESKTOP }
        });

        const rows = data.split(/<tr[^>]*>/gi).filter(r => r.includes('magnet:?') && r.includes('<td'));
        
        return rows.map(row => {
            const magnetMatch = row.match(/href=["'](magnet:\?xt=urn:btih:[^"']+)["']/i);
            if (!magnetMatch) return null;
            
            const titleMatch = row.match(/<a[^>]*>([^<]+)<\/a>/i);
            const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : "Unknown";
            const sizeMatch = row.match(/([\d.,]+\s*[A-Z]+)/i);
            const size = sizeMatch ? sizeMatch[1] : "Unknown";

            return {
                title: title,
                magnet: magnetMatch[1],
                size: size,
                sizeBytes: parseSize(size),
                seeders: 0, 
                source: 'UIndex',
                quality: extractQuality(title)
            };
        }).filter(Boolean);

    } catch (e) {
        console.error("❌ UIndex Error:", e.message);
        return [];
    }
}

/* ===========================================================
   🔴 SEARCH MAGNET (MAIN FUNCTION)
   =========================================================== */
async function searchMagnet(title, year) {
    const cleanTitle = cleanString(title);
    const queryIta = `${cleanTitle} ITA`;
    
    console.log(`\n🔍 [SEARCH] "${cleanTitle}" (${year})`);

    const promises = [
        searchCorsaro(cleanTitle), 
        searchUIndex(queryIta),
        searchKnaben(cleanTitle) // 🔥 Cerca SOLO il titolo, senza "ITA", per trovare i risultati globali
    ];

    const resultsArray = await Promise.allSettled(promises);
    
    let allResults = [];
    resultsArray.forEach(res => {
        if (res.status === 'fulfilled') allResults.push(...res.value);
    });

    // --- DEDUPLICAZIONE ---
    const uniqueMap = new Map();
    
    allResults.forEach(item => {
        const hash = extractInfoHash(item.magnet);
        if (!hash) return;

        if (!uniqueMap.has(hash)) {
            uniqueMap.set(hash, item);
        } else {
            const existing = uniqueMap.get(hash);
            // Priorità: Corsaro > Knaben (se ITA) > UIndex
            if (item.source === 'CorsaroNero') {
                uniqueMap.set(hash, item); 
            } else if (item.source === 'Knaben' && ITA_REGEX.test(item.title) && existing.source !== 'CorsaroNero') {
                uniqueMap.set(hash, item); 
            }
        }
    });

    const uniqueResults = [...uniqueMap.values()];

    // --- ORDINAMENTO (Smart Ranking) ---
    uniqueResults.sort((a, b) => {
        const isCorsaroA = a.source === 'CorsaroNero';
        const isCorsaroB = b.source === 'CorsaroNero';
        
        // 1. Corsaro SEMPRE primo
        if (isCorsaroA && !isCorsaroB) return -1;
        if (!isCorsaroA && isCorsaroB) return 1;

        // 2. Qualità (4K > 1080p > altro)
        const qScore = (q) => (q === '4k' ? 3 : q === '1080p' ? 2 : 1);
        const qualityDiff = qScore(b.quality) - qScore(a.quality);
        if (qualityDiff !== 0) return qualityDiff;

        // 3. Dimensione
        return b.sizeBytes - a.sizeBytes;
    });

    console.log(`✅ Found ${uniqueResults.length} unique results.`);
    
    // Log Sources
    const sources = uniqueResults.reduce((acc, curr) => {
        acc[curr.source] = (acc[curr.source] || 0) + 1;
        return acc;
    }, {});
    console.log(`📊 Sources: ${JSON.stringify(sources)}`);

    return uniqueResults.slice(0, 40); 
}

module.exports = { searchMagnet };
